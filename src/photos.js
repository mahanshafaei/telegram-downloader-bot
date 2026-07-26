// src/photos.js
//
// Photo-post support (Instagram carousels, TikTok photo mode, and any other
// site gallery-dl understands). yt-dlp only handles videos, so image posts
// used to fail with "there is no video in this post"; this module fills the
// gap using gallery-dl's --dump-json mode, which returns direct CDN image
// URLs without downloading anything.
//
// The bot then sends those URLs straight to Telegram (sendMediaGroup /
// sendPhoto) so Telegram's servers fetch the images — the fastest possible
// path. If Telegram refuses a CDN URL, the caller falls back to downloading
// the images and uploading them as multipart (see downloadImages).

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { commandWorks } from "./ytdlp.js";

/**
 * Resolve gallery-dl. Returns the command name or null when not installed.
 * @returns {Promise<string | null>}
 */
export async function findGalleryDl() {
  if (await commandWorks("gallery-dl", ["--version"])) return "gallery-dl";
  return null;
}

// TikTok photo posts have an unambiguous URL: /@user/photo/<id>. For those we
// skip the doomed yt-dlp attempt entirely and go straight to the photo path.
export function isLikelyPhotoUrl(url) {
  try {
    const u = new URL(url);
    return (
      (u.hostname === "www.tiktok.com" || u.hostname.endsWith(".tiktok.com")) &&
      /\/photo\/\d+/.test(u.pathname)
    );
  } catch {
    return false;
  }
}

const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|heic|avif)(\?|$)/i;

/**
 * @typedef {Object} PhotoPost
 * @property {string[]} urls  direct image URLs, post order
 * @property {string} [title] post caption/description, when available
 */

/**
 * Ask gallery-dl for a post's image URLs without downloading anything
 * (`gallery-dl -j`). Output is a JSON array of [msgtype, ...] entries where
 * msgtype 3 is a file: [3, "https://…", {metadata}]. TikTok photo posts also
 * yield the slideshow's background music as a file with metadata.type
 * "audio" — that (and covers/subtitles) must be filtered out.
 *
 * @param {string} galleryDl command from findGalleryDl()
 * @param {string} url       post URL
 * @returns {Promise<PhotoPost>} urls is empty when the post has no images
 */
export async function fetchPhotoPost(galleryDl, url) {
  const { code, stdout, stderr } = await new Promise((resolve, reject) => {
    const child = spawn(galleryDl, ["-j", "--", url]);
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (c) => resolve({ code: c, stdout: out, stderr: err }));
  });

  let entries;
  try {
    entries = JSON.parse(stdout);
  } catch {
    entries = null;
  }
  if (!Array.isArray(entries)) {
    throw new Error(cleanGalleryDlError(stderr) || `gallery-dl exit ${code}`);
  }

  const urls = [];
  let title;
  for (const entry of entries) {
    if (!Array.isArray(entry)) continue;
    // [2, {directory metadata}] — grab the post description for the caption.
    if (entry[0] === 2 && entry[1] && typeof entry[1] === "object") {
      title ||= firstNonEmpty(entry[1], ["title", "desc", "description", "content"]);
      continue;
    }
    // [3, url, {file metadata}]
    if (entry[0] !== 3 || typeof entry[1] !== "string") continue;
    const fileUrl = entry[1];
    const meta = entry[2] && typeof entry[2] === "object" ? entry[2] : {};
    // Trust the extractor's type when present; fall back to the extension.
    const type = meta.type;
    const isImage = type
      ? type === "image"
      : IMAGE_EXT_RE.test(fileUrl) ||
        ["jpg", "jpeg", "png", "webp", "gif"].includes(meta.extension);
    if (!isImage) continue;
    urls.push(fileUrl);
    title ||= firstNonEmpty(meta, ["title", "desc", "description", "content"]);
  }

  if (urls.length === 0 && code !== 0) {
    throw new Error(cleanGalleryDlError(stderr) || `gallery-dl exit ${code}`);
  }
  return { urls, title };
}

function firstNonEmpty(obj, keys) {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

// gallery-dl logs "[tiktok][error] <url>: reason" — keep just the reason.
function cleanGalleryDlError(stderr) {
  const line = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /\[error\]/i.test(l))
    .at(-1);
  return line ? line.replace(/^\[[^\]]*\]\[[^\]]*\]\s*/, "").replace(/^https?:\S+:\s*/, "") : "";
}

// Some CDNs refuse requests without a browsery user agent.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/**
 * Fallback for when Telegram won't fetch the CDN URLs itself: download the
 * images into `outDir` and convert anything that isn't jpg/png (webp, heic…)
 * to jpg with ffmpeg so Telegram accepts the upload.
 *
 * @param {string[]} urls
 * @param {string} outDir     existing directory to write into
 * @param {string} [ffmpeg]   ffmpeg command (defaults to PATH)
 * @returns {Promise<string[]>} local file paths, same order as urls
 */
export async function downloadImages(urls, outDir, ffmpeg = "ffmpeg") {
  const files = [];
  for (const [i, url] of urls.entries()) {
    const res = await fetch(url, { headers: { "user-agent": UA } });
    if (!res.ok) throw new Error(`image fetch failed (${res.status})`);
    const ext = extFor(url, res.headers.get("content-type"));
    const file = path.join(outDir, `photo${i}.${ext}`);
    await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
    if (ext === "jpg" || ext === "png") {
      files.push(file);
      continue;
    }
    const converted = path.join(outDir, `photo${i}.conv.jpg`);
    const ok = await new Promise((resolve) => {
      const child = spawn(ffmpeg, ["-y", "-i", file, "-frames:v", "1", converted]);
      child.on("error", () => resolve(false));
      child.on("close", (c) => resolve(c === 0));
    });
    files.push(ok ? converted : file);
  }
  return files;
}

function extFor(url, contentType) {
  const fromType = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/heic": "heic",
    "image/avif": "avif",
  }[(contentType || "").split(";")[0].trim()];
  if (fromType) return fromType;
  const m = IMAGE_EXT_RE.exec(url);
  return m ? m[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
}
