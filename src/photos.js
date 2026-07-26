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
 * gallery-dl can stall for a very long time — e.g. Instagram rate limiting
 * makes it print "Waiting for N minutes…" and sleep, repeatedly. A hard
 * timeout kills it so a chat never hangs on "Fetching photos…" forever.
 *
 * Instagram gets a second chance: its default REST API is aggressively
 * blocked for anonymous callers (401/429), while the GraphQL web API the
 * extractor also supports often still works — so an empty/failed first
 * attempt is retried once with `-o api=graphql`. The two attempts share the
 * time budget.
 *
 * @param {string} galleryDl command from findGalleryDl()
 * @param {string} url       post URL
 * @param {{timeoutMs?: number, cookiesFile?: string}} [opts]  timeoutMs is the
 *   total budget across attempts; cookiesFile is a Netscape cookies.txt
 *   (Instagram in particular usually needs login cookies)
 * @returns {Promise<PhotoPost>} urls is empty when the post has no images
 */
export async function fetchPhotoPost(galleryDl, url, opts = {}) {
  const totalTimeoutMs = opts.timeoutMs ?? 50_000;
  const baseArgs = opts.cookiesFile ? ["--cookies", opts.cookiesFile] : [];
  const attempts = [[]];
  try {
    if (new URL(url).hostname.includes("instagram")) {
      attempts.push(["-o", "api=graphql"]);
    }
  } catch {}
  const perAttemptMs = Math.floor(totalTimeoutMs / attempts.length);

  let lastError;
  for (const extraArgs of attempts) {
    try {
      const post = await runGalleryDl(galleryDl, url, [...baseArgs, ...extraArgs], perAttemptMs);
      if (post.urls.length) return post;
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) throw lastError;
  return { urls: [], title: undefined };
}

async function runGalleryDl(galleryDl, url, extraArgs, timeoutMs) {
  const { code, stdout, stderr, timedOut } = await new Promise(
    (resolve, reject) => {
      // -R 1: one retry is enough; failures should surface, not loop.
      const child = spawn(galleryDl, ["-R", "1", ...extraArgs, "-j", "--", url]);
      let out = "";
      let err = "";
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      timer.unref?.();
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (c) => {
        clearTimeout(timer);
        resolve({ code: c, stdout: out, stderr: err, timedOut: killed });
      });
    }
  );
  if (timedOut) {
    throw new Error(
      lastInfoLine(stderr) ||
        `Timed out fetching photos (${Math.round(timeoutMs / 1000)}s).`
    );
  }

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
  let dumpError;
  for (const entry of entries) {
    if (!Array.isArray(entry)) continue;
    // [-1, {error, message}] — gallery-dl can report failures inside the
    // dump itself, with a clean exit code and empty stderr.
    if (entry[0] === -1 && entry[1] && typeof entry[1] === "object") {
      dumpError ||= [entry[1].error, entry[1].message]
        .filter((v) => typeof v === "string" && v)
        .join(": ")
        // These messages embed full request URLs — noise in a chat message.
        .replace(/ for '[^']{40,}'/g, "")
        .slice(0, 200);
      continue;
    }
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

  if (urls.length === 0) {
    // gallery-dl exits 0 even when the extractor errored — the reason lands
    // in a stderr "[…][error]" line or in a [-1, {...}] dump entry. Go by
    // those, not just the exit code, or real failures turn into a useless
    // generic "no photos" message.
    const reason = cleanGalleryDlError(stderr) || dumpError;
    if (reason || code !== 0) {
      throw new Error(reason || `gallery-dl exit ${code}`);
    }
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

// On timeout the most useful thing gallery-dl said is usually an [info]/
// [warning] line like "Waiting for 1 minutes until 22:32 (429 Too Many
// Requests)" — surface that instead of a bare "timed out".
function lastInfoLine(stderr) {
  const line = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /\[(info|warning|error)\]/i.test(l))
    .at(-1);
  return line ? line.replace(/^\[[^\]]*\]\[[^\]]*\]\s*/, "") : "";
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
