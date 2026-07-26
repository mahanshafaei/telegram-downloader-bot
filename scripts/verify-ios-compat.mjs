#!/usr/bin/env node
// scripts/verify-ios-compat.mjs
//
// End-to-end guarantee check for iPhone playback.
//
// Telegram on iOS only plays H.264 (yuv420p) + AAC in an mp4 whose moov atom
// sits at the front. This script drives the bot's REAL download pipeline
// (buildFastChoice → download → ensureIosPlayable, the exact code bot.js runs)
// against local fixtures that mimic what Instagram and TikTok actually serve —
// including the hostile cases (HEVC-only, VP9 webm, moov-at-end, portrait
// resolutions, TikTok's "h264"/"h265" codec labels) — and asserts every
// produced file is iOS-playable.
//
// Requirements: yt-dlp, ffmpeg and ffprobe on PATH (same as the bot itself).
// Usage:        npm run verify:ios          # offline fixture suite
//               node scripts/verify-ios-compat.mjs --live <url>
//                                           # also run one real link through
//                                           # the auto-best (Instagram/TikTok)
//                                           # pipeline and verify the output

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { buildFastChoice, download } from "../src/ytdlp.js";
import {
  ensureIosPlayable,
  probeMedia,
  moovBeforeMdat,
  findFfprobe,
} from "../src/media.js";

const ffprobe = await findFfprobe();
if (!ffprobe) {
  console.error("ffprobe not found on PATH — install ffmpeg first.");
  process.exit(1);
}
for (const bin of ["ffmpeg", "yt-dlp"]) {
  if (spawnSync(bin, ["-version"], { stdio: "ignore" }).status !== 0 &&
      spawnSync(bin, ["--version"], { stdio: "ignore" }).status !== 0) {
    console.error(`${bin} not found on PATH — install it first.`);
    process.exit(1);
  }
}

const work = await fs.mkdtemp(path.join(os.tmpdir(), "tgdl-verify-"));
const fixturesDir = path.join(work, "fixtures");
await fs.mkdir(fixturesDir, { recursive: true });

function ffmpeg(args) {
  const res = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  if (res.status !== 0) {
    throw new Error(`ffmpeg ${args.join(" ")}\n${res.stderr}`);
  }
}

console.log("Generating fixtures (short synthetic clips)…");
const V = (size) => ["-f", "lavfi", "-i", `testsrc2=size=${size}:rate=30:duration=3`];
const A = ["-f", "lavfi", "-i", "sine=frequency=440:duration=3"];
const enc264 = ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac"];

// Classic Instagram: H.264+AAC portrait mp4 with the moov atom at the END.
ffmpeg([...V("720x1280"), ...A, ...enc264, path.join(fixturesDir, "h264_720_end.mp4")]);
// Lower-res variant ("540p" — 576x1024 like TikTok).
ffmpeg([...V("576x1024"), ...A, ...enc264, path.join(fixturesDir, "h264_540_end.mp4")]);
// TikTok bytevc1: HEVC — plays on Android/Desktop, not in Telegram iOS.
ffmpeg([...V("1080x1920"), ...A, "-c:v", "libx265", "-preset", "veryfast",
  "-pix_fmt", "yuv420p", "-tag:v", "hvc1", "-c:a", "aac",
  path.join(fixturesDir, "hevc_1080_end.mp4")]);
// VP9+Opus webm — what codec-agnostic "best" can pick on some sites.
ffmpeg([...V("720x1280"), ...A, "-c:v", "libvpx-vp9", "-b:v", "500k",
  "-c:a", "libopus", path.join(fixturesDir, "vp9.webm")]);
// Wrong-audio case: H.264 video but MP3 audio.
ffmpeg([...V("720x1280"), ...A, "-c:v", "libx264", "-preset", "veryfast",
  "-pix_fmt", "yuv420p", "-c:a", "libmp3lame",
  path.join(fixturesDir, "h264_mp3_end.mp4")]);
// Control: already fully compliant (H.264+AAC, faststart).
ffmpeg([...V("720x1280"), ...A, ...enc264, "-movflags", "+faststart",
  path.join(fixturesDir, "h264_720_fast.mp4")]);

// Serve fixtures over local HTTP so yt-dlp downloads them like a real site.
const server = http.createServer(async (req, res) => {
  try {
    const file = path.join(fixturesDir, path.basename(new URL(req.url, "http://x").pathname));
    const data = await fs.readFile(file);
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": data.length });
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// Minimal processed info.json the way each extractor shapes it. `download()`
// feeds these to yt-dlp via --load-info-json, exercising the bot's real
// format selection (-f/-S) against realistic metadata.
function fmt(id, file, props) {
  return { format_id: id, url: `${base}/${file}`, ext: "mp4", protocol: "https", ...props };
}
const INFOS = {
  // TikTok: muxed-only formats, portrait heights (long side!), vcodec labels
  // "h264"/"h265" — and the h265 ranks higher in yt-dlp's default sort.
  tiktok: {
    id: "t1", title: "tiktok sim", extractor: "TikTok", extractor_key: "TikTok",
    webpage_url: "https://www.tiktok.com/@x/video/1", duration: 3,
    formats: [
      fmt("h264_540p", "h264_540_end.mp4", { vcodec: "h264", acodec: "aac", width: 576, height: 1024, tbr: 78 }),
      fmt("h264_720p", "h264_720_end.mp4", { vcodec: "h264", acodec: "aac", width: 720, height: 1280, tbr: 120 }),
      fmt("bytevc1_1080p", "hevc_1080_end.mp4", { vcodec: "h265", acodec: "aac", width: 1080, height: 1920, tbr: 194 }),
    ],
  },
  // Instagram: one muxed file, extractor reports no codecs at all — and the
  // actual bytes are HEVC. Selection can't save us; the post-download pass must.
  instagramHevcUnlabeled: {
    id: "i1", title: "ig hevc sim", extractor: "Instagram", extractor_key: "Instagram",
    webpage_url: "https://www.instagram.com/reel/x/", duration: 3,
    formats: [fmt("dl", "hevc_1080_end.mp4", { width: 1080, height: 1920 })],
  },
  // Instagram, common case: H.264+AAC but moov at the end (not streamable).
  instagramMoovEnd: {
    id: "i2", title: "ig moov sim", extractor: "Instagram", extractor_key: "Instagram",
    webpage_url: "https://www.instagram.com/reel/y/", duration: 3,
    formats: [fmt("dl", "h264_720_end.mp4", { vcodec: "avc1.64001f", width: 720, height: 1280 })],
  },
  // Only a VP9/Opus webm on offer.
  webmOnly: {
    id: "w1", title: "webm sim", extractor: "generic", extractor_key: "Generic",
    webpage_url: `${base}/vp9.webm`, duration: 3,
    formats: [fmt("dl", "vp9.webm", { ext: "webm", vcodec: "vp9", acodec: "opus", width: 720, height: 1280 })],
  },
  // H.264 video with MP3 audio — video must be copied, audio re-encoded.
  mp3Audio: {
    id: "m1", title: "mp3 audio sim", extractor: "generic", extractor_key: "Generic",
    webpage_url: `${base}/h264_mp3_end.mp4`, duration: 3,
    formats: [fmt("dl", "h264_mp3_end.mp4", { vcodec: "avc1.64001f", acodec: "mp3", width: 720, height: 1280 })],
  },
};

let failures = 0;
function check(name, cond, detail) {
  const ok = Boolean(cond);
  console.log(`  ${ok ? "✅" : "❌"} ${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

async function runCase(name, info, { expectAction, expectMaxRes } = {}) {
  console.log(`\n▶ ${name}`);
  const infoJsonPath = path.join(work, `${info.id}.json`);
  await fs.writeFile(infoJsonPath, JSON.stringify(info));
  const outDir = path.join(work, `out-${info.id}`);
  await fs.mkdir(outDir, { recursive: true });

  // The exact auto-best pipeline from bot.js.
  const choice = buildFastChoice(720);
  const filePath = await download({
    ytdlp: "yt-dlp",
    url: info.webpage_url,
    infoJsonPath,
    choice,
    outDir,
  });
  const fixed = await ensureIosPlayable(filePath, { ffprobe, maxRes: choice.maxRes });

  const out = await probeMedia(ffprobe, fixed.path);
  const moovFirst = await moovBeforeMdat(fixed.path);
  check("video is H.264", out?.vcodec === "h264", `got ${out?.vcodec}`);
  check("pixel format is yuv420p", ["yuv420p", "yuvj420p"].includes(out?.pixFmt), `got ${out?.pixFmt}`);
  check("audio is AAC (or none)", !out?.acodec || out?.acodec === "aac", `got ${out?.acodec}`);
  check("container is mp4", out?.isMp4 === true, "not an mp4");
  check("moov atom at front (faststart)", moovFirst === true, `moovBeforeMdat=${moovFirst}`);
  check("upload metadata present", fixed.width > 0 && fixed.height > 0 && fixed.duration > 0,
    JSON.stringify({ w: fixed.width, h: fixed.height, d: fixed.duration }));
  if (expectAction) {
    check(`pipeline action is "${expectAction}"`, fixed.action === expectAction, `got "${fixed.action}"`);
  }
  if (expectMaxRes) {
    const res = Math.min(out?.width ?? Infinity, out?.height ?? Infinity);
    check(`resolution ≤ ${expectMaxRes}p`, res <= expectMaxRes, `got ${out?.width}x${out?.height}`);
  }
}

try {
  // The TikTok case proves format SELECTION: with h264 720p and h265 1080p on
  // offer, the bot must pick the h264 720p (action "remuxed", never
  // "transcoded" — a transcode would mean it downloaded the HEVC).
  await runCase("TikTok-style: h264 vs bytevc1(h265), portrait", INFOS.tiktok,
    { expectAction: "remuxed", expectMaxRes: 720 });
  await runCase("Instagram-style: unlabeled HEVC file", INFOS.instagramHevcUnlabeled,
    { expectAction: "transcoded", expectMaxRes: 720 });
  await runCase("Instagram-style: H.264 with moov at end", INFOS.instagramMoovEnd,
    { expectAction: "remuxed" });
  await runCase("VP9/Opus webm only", INFOS.webmOnly, { expectAction: "transcoded" });
  await runCase("H.264 video + MP3 audio", INFOS.mp3Audio, { expectAction: "transcoded" });

  const liveIdx = process.argv.indexOf("--live");
  if (liveIdx !== -1) {
    const url = process.argv[liveIdx + 1];
    if (!url) throw new Error("--live needs a URL");
    console.log(`\n▶ LIVE: ${url}`);
    const outDir = path.join(work, "out-live");
    await fs.mkdir(outDir, { recursive: true });
    const filePath = await download(
      { ytdlp: "yt-dlp", url, choice: buildFastChoice(720), outDir },
      { onProgress: () => {} }
    );
    const fixed = await ensureIosPlayable(filePath, { ffprobe });
    const out = await probeMedia(ffprobe, fixed.path);
    const moovFirst = await moovBeforeMdat(fixed.path);
    check("video is H.264", out?.vcodec === "h264", `got ${out?.vcodec}`);
    check("audio is AAC (or none)", !out?.acodec || out?.acodec === "aac", `got ${out?.acodec}`);
    check("moov atom at front", moovFirst === true, `moovBeforeMdat=${moovFirst}`);
    console.log(`  ↳ ${out?.width}x${out?.height}, ${fixed.duration}s, action=${fixed.action}`);
  }
} finally {
  server.close();
  await fs.rm(work, { recursive: true, force: true }).catch(() => {});
}

console.log(failures === 0
  ? "\nAll checks passed — every produced file is iPhone-playable."
  : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
