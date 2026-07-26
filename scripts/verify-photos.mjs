#!/usr/bin/env node
// scripts/verify-photos.mjs
//
// End-to-end check for the photo-post path. Drives the bot's REAL modules —
// fetchPhotoPost (gallery-dl -j parsing), Telegram.sendPhotoUrls /
// sendPhotoFiles (album chunking), and downloadImages (CDN fallback with
// webp→jpg conversion) — against:
//   • a stub gallery-dl that prints byte-real `-j` output shapes (captured
//     from gallery-dl's TikTok/wikimedia extractors), and
//   • a stub Telegram Bot API server that validates every payload it gets
//     (album chunk sizes, caption placement, attach:// multipart wiring).
//
// Requirements: only node + ffmpeg (for the webp conversion check).
// Usage: npm run verify:photos

import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Telegram } from "../src/telegram.js";
import { fetchPhotoPost, downloadImages } from "../src/photos.js";

const work = await fs.mkdtemp(path.join(os.tmpdir(), "tgdl-photos-"));
let failures = 0;
function check(name, cond, detail) {
  const ok = Boolean(cond);
  console.log(`  ${ok ? "✅" : "❌"} ${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------------------
// 1. fetchPhotoPost: parse a TikTok-photo-shaped gallery-dl -j dump.
//    Shape matches gallery_dl/extractor/tiktok.py: images have type "image",
//    the slideshow music is a file entry with type "audio" and MUST be
//    dropped, covers/subtitles likewise.
// ---------------------------------------------------------------------------
console.log("▶ gallery-dl -j parsing (TikTok photo post shape)");
const tiktokDump = JSON.stringify([
  [2, { category: "tiktok", desc: "three cute cats 🐈", post_type: "image" }],
  [3, "https://p16-sign.tiktokcdn-us.com/obj/1.webp?x-expires=1", { type: "image", title: "three cute cats 🐈", num: 1, extension: "webp" }],
  [3, "https://p16-sign.tiktokcdn-us.com/obj/2.jpeg?x-expires=1", { type: "image", title: "three cute cats 🐈", num: 2, extension: "jpeg" }],
  [3, "https://p16-sign.tiktokcdn-us.com/obj/3.jpeg?x-expires=1", { type: "image", title: "three cute cats 🐈", num: 3, extension: "jpeg" }],
  [3, "https://sf16-ies-music.tiktokcdn.com/obj/musically-maliva-obj/song.mp3", { type: "audio", title: "three cute cats 🐈", extension: "mp3" }],
]);
const stub = path.join(work, "gallery-dl-stub.mjs");
await fs.writeFile(stub, `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("1.32.8-stub"); process.exit(0); }
process.stdout.write(${JSON.stringify(tiktokDump)});
`);
await fs.chmod(stub, 0o755);

const post = await fetchPhotoPost(stub, "https://www.tiktok.com/@x/photo/1");
check("3 image URLs extracted", post.urls.length === 3, `got ${post.urls.length}`);
check("audio track filtered out", !post.urls.some((u) => u.includes(".mp3")), post.urls.join());
check("order preserved", post.urls[0].includes("/1.webp") && post.urls[2].includes("/3.jpeg"), post.urls.join());
check("caption extracted", post.title === "three cute cats 🐈", `got ${JSON.stringify(post.title)}`);

// No-type metadata (e.g. wikimedia shape) falls back to extension checks.
console.log("▶ gallery-dl -j parsing (extension fallback, no type field)");
const plainDump = JSON.stringify([
  [2, { category: "wikimediacommons" }],
  [3, "https://upload.wikimedia.org/wikipedia/commons/a/a9/Example.jpg", { extension: "jpg" }],
  [3, "https://upload.wikimedia.org/video/clip.mp4", { extension: "mp4" }],
]);
await fs.writeFile(stub, `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("stub"); process.exit(0); }
process.stdout.write(${JSON.stringify(plainDump)});
`);
const post2 = await fetchPhotoPost(stub, "https://example.com/x");
check("jpg kept, mp4 dropped", post2.urls.length === 1 && post2.urls[0].endsWith(".jpg"), post2.urls.join());

// Errors surface cleanly.
await fs.writeFile(stub, `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("stub"); process.exit(0); }
console.error('[tiktok][error] https://x: Login required to access this post');
process.exit(1);
`);
const err = await fetchPhotoPost(stub, "https://x").catch((e) => e);
check("extractor error surfaced", err instanceof Error && /Login required/.test(err.message), String(err && err.message));

// ---------------------------------------------------------------------------
// 2. Telegram album senders against a stub Bot API.
// ---------------------------------------------------------------------------
console.log("▶ Telegram album chunking & captions (stub Bot API)");
const calls = [];
let rejectUrlSends = false;
const api = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const method = req.url.split("/").pop();
  const contentType = req.headers["content-type"] || "";
  let payload = {};
  if (contentType.includes("application/json")) {
    payload = JSON.parse(body.toString());
  } else if (contentType.includes("multipart/form-data")) {
    const raw = body.toString("latin1");
    payload = {
      multipart: true,
      media: /name="media"\r\n\r\n(.*?)\r\n/s.exec(raw)?.[1],
      attachedFiles: [...raw.matchAll(/name="(photo\d+|photo)"; filename=/g)].map((m) => m[1]),
    };
  }
  calls.push({ method, payload });
  if (rejectUrlSends && !payload.multipart && (method === "sendMediaGroup" || method === "sendPhoto")) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: failed to get HTTP URL content" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, result: [] }));
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));
const tg = new Telegram("TEST:TOKEN", `http://127.0.0.1:${api.address().port}`);

// 13 photos → sendMediaGroup(10) + sendMediaGroup(3), caption once.
const urls13 = Array.from({ length: 13 }, (_, i) => `https://cdn.example/img${i}.jpg`);
await tg.sendPhotoUrls(123, urls13, { caption: "cap" });
const groups = calls.filter((c) => c.method === "sendMediaGroup");
check("13 URLs → two albums", groups.length === 2, `got ${calls.map((c) => c.method).join()}`);
check("album sizes 10 + 3", groups[0]?.payload.media?.length === 10 && groups[1]?.payload.media?.length === 3,
  JSON.stringify(groups.map((g) => g.payload.media?.length)));
const captioned = groups.flatMap((g) => g.payload.media ?? []).filter((m) => m.caption);
check("caption on exactly one item (first)", captioned.length === 1 && groups[0].payload.media[0].caption === "cap",
  JSON.stringify(captioned));
check("all items are type photo", groups.every((g) => g.payload.media.every((m) => m.type === "photo")), "");

// 1 photo → plain sendPhoto.
calls.length = 0;
await tg.sendPhotoUrls(123, ["https://cdn.example/only.jpg"], { caption: "c" });
check("single photo uses sendPhoto", calls.length === 1 && calls[0].method === "sendPhoto"
  && calls[0].payload.photo === "https://cdn.example/only.jpg", JSON.stringify(calls.map((c) => c.method)));

// 11 photos → album of 10 + single sendPhoto.
calls.length = 0;
await tg.sendPhotoUrls(123, urls13.slice(0, 11), {});
check("11 URLs → album(10) + sendPhoto", calls.length === 2 && calls[0].method === "sendMediaGroup"
  && calls[1].method === "sendPhoto", calls.map((c) => c.method).join());

// URL send rejected → caller's fallback path: local files via attach://.
console.log("▶ multipart fallback (attach://)");
calls.length = 0;
rejectUrlSends = true;
const urlErr = await tg.sendPhotoUrls(123, urls13.slice(0, 2), {}).catch((e) => e);
check("URL rejection propagates for fallback", urlErr instanceof Error && /failed to get HTTP URL content/.test(urlErr.message),
  String(urlErr && urlErr.message));

const files = [];
for (const name of ["a", "b", "c"]) {
  const f = path.join(work, `${name}.jpg`);
  await fs.writeFile(f, Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 0, 0xff, 0xd9]));
  files.push(f);
}
calls.length = 0;
await tg.sendPhotoFiles(123, files, { caption: "cap" });
const mg = calls.find((c) => c.method === "sendMediaGroup");
check("files sent as one multipart album", calls.length === 1 && Boolean(mg?.payload.multipart), calls.map((c) => c.method).join());
check("3 files attached", mg?.payload.attachedFiles?.length === 3, JSON.stringify(mg?.payload.attachedFiles));
const mediaJson = JSON.parse(mg?.payload.media ?? "[]");
check("media references attach://", mediaJson.every((m, i) => m.media === `attach://photo${i}`), mg?.payload.media);
check("caption once in multipart album", mediaJson.filter((m) => m.caption).length === 1 && mediaJson[0].caption === "cap",
  mg?.payload.media);

// ---------------------------------------------------------------------------
// 3. downloadImages fallback: fetch from a local CDN stub, convert webp→jpg.
// ---------------------------------------------------------------------------
console.log("▶ downloadImages fallback (webp conversion)");
const haveFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
if (!haveFfmpeg) {
  console.log("  (ffmpeg not on PATH — skipping)");
} else {
  const webp = path.join(work, "src.webp");
  const jpg = path.join(work, "src.jpg");
  spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=red:size=64x64", "-frames:v", "1", webp], { stdio: "ignore" });
  spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=blue:size=64x64", "-frames:v", "1", jpg], { stdio: "ignore" });
  const cdn = http.createServer(async (req, res) => {
    const file = req.url.includes("webp") ? webp : jpg;
    const type = req.url.includes("webp") ? "image/webp" : "image/jpeg";
    const data = await fs.readFile(file);
    res.writeHead(200, { "content-type": type });
    res.end(data);
  });
  await new Promise((r) => cdn.listen(0, "127.0.0.1", r));
  const cdnBase = `http://127.0.0.1:${cdn.address().port}`;
  const outDir = path.join(work, "dl");
  await fs.mkdir(outDir, { recursive: true });
  const got = await downloadImages([`${cdnBase}/a.webp`, `${cdnBase}/b.jpg`], outDir);
  check("2 files downloaded", got.length === 2, JSON.stringify(got));
  check("webp converted to jpg for Telegram", got[0].endsWith(".jpg"), got[0]);
  check("jpg passed through untouched", got[1].endsWith(".jpg") && !got[1].includes(".conv."), got[1]);
  cdn.close();
}

api.close();
await fs.rm(work, { recursive: true, force: true }).catch(() => {});
console.log(failures === 0
  ? "\nAll photo-path checks passed."
  : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
