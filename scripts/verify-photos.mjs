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
import { prepareCookiesFile } from "../src/cookies.js";

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

// gallery-dl exits 0 even when the extractor fails (it logs "[…][error] …"
// and dumps "[]") — the error must surface anyway, not become a silent
// "no photos" that turns into a useless generic chat message.
console.log("▶ exit-0 extractor failure still surfaces its error");
await fs.writeFile(stub, `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("stub"); process.exit(0); }
console.error("[tiktok][error] https://x: Requested post not available");
process.stdout.write("[]");
process.exit(0);
`);
const swallowed = await fetchPhotoPost(stub, "https://www.tiktok.com/@x/photo/1").catch((e) => e);
check("error line beats exit code 0", swallowed instanceof Error && /Requested post not available/.test(swallowed.message),
  String(swallowed && (swallowed.message ?? "resolved without error")));

// Third failure shape: clean exit, clean stderr, but a [-1, {error,message}]
// entry inside the JSON dump (seen live from Instagram's GraphQL API).
await fs.writeFile(stub, `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("stub"); process.exit(0); }
process.stdout.write(JSON.stringify([[-1, { error: "HttpError", message: "'401 Unauthorized' for 'https://www.instagram.com/graphql/…'" }]]));
`);
const dumpErr = await fetchPhotoPost(stub, "https://www.tiktok.com/@x/photo/1").catch((e) => e);
check("[-1] dump entry surfaces as error", dumpErr instanceof Error && /HttpError: '401 Unauthorized'/.test(dumpErr.message),
  String(dumpErr && (dumpErr.message ?? "resolved without error")));

// …but a genuinely empty, error-free result stays a clean empty (caller then
// says "no photos" legitimately).
await fs.writeFile(stub, `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("stub"); process.exit(0); }
process.stdout.write("[]");
`);
const empty = await fetchPhotoPost(stub, "https://example.com/x");
check("clean empty result is not an error", Array.isArray(empty.urls) && empty.urls.length === 0, JSON.stringify(empty));

// Instagram gets a second attempt with the GraphQL API when the default REST
// API comes back blocked/empty. The stub fails WITHOUT -o api=graphql and
// succeeds WITH it — proving the retry wiring.
console.log("▶ Instagram GraphQL retry");
await fs.writeFile(stub, `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("stub"); process.exit(0); }
const graphql = process.argv.includes("api=graphql");
if (!graphql) {
  console.error("[instagram][error] https://x: 401 Unauthorized");
  process.stdout.write("[]");
  process.exit(0);
}
process.stdout.write(JSON.stringify([
  [2, { category: "instagram", description: "sunset pics" }],
  [3, "https://scontent.cdninstagram.com/v/1.jpg?x=1", { extension: "jpg" }],
  [3, "https://scontent.cdninstagram.com/v/2.jpg?x=1", { extension: "jpg" }],
]));
`);
const igPost = await fetchPhotoPost(stub, "https://www.instagram.com/p/ABC123/");
check("REST failure retried via GraphQL", igPost.urls.length === 2, JSON.stringify(igPost.urls));
check("caption from GraphQL attempt", igPost.title === "sunset pics", JSON.stringify(igPost.title));
// Non-Instagram links must NOT get the GraphQL retry (single attempt).
const nonIg = await fetchPhotoPost(stub, "https://www.tiktok.com/@x/photo/1").catch((e) => e);
check("no GraphQL retry for non-Instagram", nonIg instanceof Error && /401 Unauthorized/.test(nonIg.message),
  String(nonIg && (nonIg.message ?? JSON.stringify(nonIg))));

// cookiesFile must reach gallery-dl as --cookies <file> on every attempt.
console.log("▶ cookies file forwarding");
await fs.writeFile(stub, `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("stub"); process.exit(0); }
const i = process.argv.indexOf("--cookies");
if (i === -1 || !process.argv[i + 1]) { console.error("[t][error] x: missing --cookies"); process.stdout.write("[]"); process.exit(0); }
process.stdout.write(JSON.stringify([[3, "https://cdn.example/c.jpg", { type: "image" }]]));
`);
const withCookies = await fetchPhotoPost(stub, "https://www.instagram.com/p/x/", { cookiesFile: "/tmp/cookies.txt" });
check("--cookies forwarded to gallery-dl", withCookies.urls.length === 1, JSON.stringify(withCookies));

// A stalled gallery-dl (e.g. Instagram 429 wait loops) must be killed by the
// timeout, surfacing its last log line — never hang the chat forever.
console.log("▶ gallery-dl stall → hard timeout");
await fs.writeFile(stub, `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("stub"); process.exit(0); }
console.error("[instagram][info] Waiting for 1 minutes until 22:32:22 (429 Too Many Requests)");
setTimeout(() => {}, 120000); // hang
`);
const t0 = Date.now();
const stallErr = await fetchPhotoPost(stub, "https://instagram.com/p/x", { timeoutMs: 1500 }).catch((e) => e);
check("stall killed within timeout", stallErr instanceof Error && Date.now() - t0 < 10000,
  `took ${Date.now() - t0}ms: ${String(stallErr && stallErr.message)}`);
check("timeout error carries the useful log line", /429 Too Many Requests/.test(String(stallErr && stallErr.message)),
  String(stallErr && stallErr.message));

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
// 2b. Cookie-file normalization: every common export format must become a
//     jar that REAL yt-dlp accepts (validated by loading it with yt-dlp).
// ---------------------------------------------------------------------------
console.log("▶ cookies normalization (all export formats)");
const cookieDir = path.join(work, "cookies");
await fs.mkdir(cookieDir, { recursive: true });
const haveYtdlp = spawnSync("yt-dlp", ["--version"], { stdio: "ignore" }).status === 0;

async function cookieCase(name, content, expectCookieRe) {
  const src = path.join(cookieDir, `${name}.src`);
  await fs.writeFile(src, content);
  let prepared;
  try {
    prepared = await prepareCookiesFile(src, cookieDir);
  } catch (e) {
    check(`${name}: converts`, false, e.message);
    return;
  }
  const jar = await fs.readFile(prepared.path, "utf8");
  check(`${name}: converts (${prepared.note})`,
    jar.startsWith("# Netscape HTTP Cookie File") && expectCookieRe.test(jar),
    JSON.stringify(jar.slice(0, 120)));
  check(`${name}: fields are tab-separated`,
    jar.split("\n").filter((l) => l && !l.startsWith("# ")).every((l) => l.split("\t").length === 7),
    jar);
  if (haveYtdlp) {
    // The real consumer decides: yt-dlp must load the jar without the
    // "does not look like a Netscape format cookies file" error.
    const res = spawnSync("yt-dlp", ["--cookies", prepared.path, "--simulate", "--no-warnings",
      "--print", "id", "dummy:blank"], { encoding: "utf8" });
    const rejected = /does not look like a Netscape/i.test(res.stderr ?? "");
    check(`${name}: real yt-dlp accepts the jar`, !rejected, res.stderr?.slice(0, 150));
  }
  // Re-running must not modify the original file.
  const original = await fs.readFile(src, "utf8");
  check(`${name}: source file untouched`, original === content, "");
}

// Strict Netscape (control) — plus an #HttpOnly_ line, which is valid.
await cookieCase("netscape-strict",
  "# Netscape HTTP Cookie File\n.instagram.com\tTRUE\t/\tTRUE\t1900000000\tsessionid\tabc123\n#HttpOnly_.instagram.com\tTRUE\t/\tTRUE\t1900000000\tcsrftoken\txyz\n",
  /sessionid\tabc123/);
// Tabs lost to spaces + CRLF + BOM — what pasting through a terminal does.
await cookieCase("space-mangled-crlf",
  "﻿# Netscape HTTP Cookie File\r\n.instagram.com TRUE / TRUE 1900000000 sessionid abc123\r\n.instagram.com TRUE / TRUE 1900000000 ds_user_id 42\r\n",
  /sessionid\tabc123/);
// Cookie-Editor style JSON array export.
await cookieCase("json-array",
  JSON.stringify([
    { domain: ".instagram.com", hostOnly: false, path: "/", secure: true, httpOnly: true, expirationDate: 1900000000.5, name: "sessionid", value: "abc123" },
    { domain: ".instagram.com", path: "/", secure: true, name: "ds_user_id", value: "42" },
  ]),
  /sessionid\tabc123/);
// JSON wrapped in {cookies:[...]} and session cookies without expiry.
await cookieCase("json-wrapped",
  JSON.stringify({ url: "https://instagram.com", cookies: [{ domain: "www.instagram.com", name: "sessionid", value: "abc123" }] }),
  /sessionid\tabc123/);
// A raw copied Cookie request header.
await cookieCase("header-string",
  "mid=Zxyz; ds_user_id=42; sessionid=abc%3A123; csrftoken=tok",
  /sessionid\tabc%3A123/);
// Garbage must fail with a clear error, not silently produce an empty jar.
{
  const src = path.join(cookieDir, "garbage.src");
  await fs.writeFile(src, "this is not cookies at all\njust some text\n");
  const err = await prepareCookiesFile(src, cookieDir).catch((e) => e);
  check("garbage: rejected with clear error", err instanceof Error && /no cookies could be parsed/.test(err.message),
    String(err && (err.message ?? "resolved")));
}

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
