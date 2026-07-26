// src/media.js
//
// iOS-playability guarantee for downloaded videos.
//
// Telegram on iPhone plays a video message only when it is an mp4 with
// H.264 (yuv420p 8-bit) video, AAC (or no) audio, and the moov atom at the
// front of the file. Android and Telegram Desktop decode almost anything
// (HEVC, VP9, AV1, moov at the end), which is why a bad file "works for
// everyone except iPhones".
//
// Format selection (see ytdlp.js) already prefers H.264/AAC, but sites don't
// always offer it and extractor codec labels aren't reliable. So after every
// download the bot inspects the real file with ffprobe and, only when needed,
// remuxes (moov at the end → stream copy with +faststart) or re-encodes
// (wrong codec → libx264/aac). A compliant file is passed through untouched.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { commandWorks } from "./ytdlp.js";

const IOS_PIX_FMTS = new Set(["yuv420p", "yuvj420p"]);

/**
 * Resolve an ffprobe binary: PATH first, then next to the resolved ffmpeg
 * (apt/brew installs ship both in one directory; ffmpeg-static does not).
 * @param {string} [ffmpegLocation] path returned by findFfmpeg(), if any
 * @returns {Promise<string | null>}
 */
export async function findFfprobe(ffmpegLocation) {
  if (await commandWorks("ffprobe", ["-version"])) return "ffprobe";
  if (ffmpegLocation) {
    const ext = process.platform === "win32" ? ".exe" : "";
    const sibling = path.join(path.dirname(ffmpegLocation), `ffprobe${ext}`);
    if (await commandWorks(sibling, ["-version"])) return sibling;
  }
  return null;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * @typedef {Object} MediaInfo
 * @property {string} [vcodec]   e.g. "h264", "hevc", "vp9", "av1"
 * @property {string} [acodec]   e.g. "aac", "opus" — undefined when no audio
 * @property {string} [pixFmt]
 * @property {number} [width]
 * @property {number} [height]
 * @property {number} [duration] seconds
 * @property {boolean} [isMp4]   container is mp4/mov family
 */

/**
 * Inspect a media file with ffprobe. Returns null when ffprobe is missing or
 * the file can't be parsed.
 * @param {string} ffprobe
 * @param {string} filePath
 * @returns {Promise<MediaInfo | null>}
 */
export async function probeMedia(ffprobe, filePath) {
  const { code, stdout } = await run(ffprobe, [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]).catch(() => ({ code: -1, stdout: "" }));
  if (code !== 0) return null;

  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }

  const streams = data.streams ?? [];
  // Skip attached cover art (mjpeg/png streams marked attached_pic).
  const video =
    streams.find(
      (s) => s.codec_type === "video" && !s.disposition?.attached_pic
    ) ?? streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const formatName = data.format?.format_name ?? "";

  return {
    vcodec: video?.codec_name,
    acodec: audio?.codec_name,
    pixFmt: video?.pix_fmt,
    width: Number(video?.width) || undefined,
    height: Number(video?.height) || undefined,
    duration:
      Number.parseFloat(data.format?.duration ?? video?.duration) || undefined,
    // ffprobe reports the mp4 family as "mov,mp4,m4a,3gp,3g2,mj2".
    isMp4: formatName.includes("mp4") || formatName.includes("mov"),
  };
}

/**
 * True when the mp4's moov atom sits before mdat (streamable / "faststart"),
 * false when it sits after, null when the file doesn't parse as an mp4.
 * Pure Node — walks the top-level box headers only.
 * @param {string} filePath
 * @returns {Promise<boolean | null>}
 */
export async function moovBeforeMdat(filePath) {
  const fh = await fs.open(filePath, "r");
  try {
    const { size: fileSize } = await fh.stat();
    const header = Buffer.alloc(16);
    let offset = 0;
    // A real mp4 has well under 100 top-level boxes; the cap guards against
    // walking a non-mp4 file whose bytes happen to look like tiny boxes.
    for (let i = 0; i < 4096 && offset + 8 <= fileSize; i++) {
      const { bytesRead } = await fh.read(header, 0, 16, offset);
      if (bytesRead < 8) return null;
      let boxSize = header.readUInt32BE(0);
      const type = header.toString("latin1", 4, 8);
      if (i === 0 && type !== "ftyp" && type !== "styp") return null;
      if (type === "moov") return true;
      if (type === "mdat") return false;
      if (boxSize === 1) {
        if (bytesRead < 16) return null;
        boxSize = Number(header.readBigUInt64BE(8));
      } else if (boxSize === 0) {
        boxSize = fileSize - offset; // box extends to end of file
      }
      if (boxSize < 8 || !Number.isFinite(boxSize)) return null;
      offset += boxSize;
    }
    return null;
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

/**
 * @typedef {Object} IosFixResult
 * @property {string} path      file to upload (may equal the input path)
 * @property {"ok"|"remuxed"|"transcoded"|"unchecked"} action
 * @property {number} [width]
 * @property {number} [height]
 * @property {number} [duration] whole seconds, for Telegram's sendVideo
 * @property {boolean} [noVideoStream] file has audio but no video at all —
 *   e.g. a TikTok photo post where yt-dlp could only grab the music track
 */

/**
 * Guarantee that a downloaded video is iOS-playable: H.264 + AAC in an mp4
 * with the moov atom at the front. No-ops on already-compliant files, stream
 * copies when only the moov position (or container) is wrong, and re-encodes
 * only the offending stream(s) otherwise. Writes any new file next to the
 * input (same temp dir, cleaned up by the caller).
 *
 * @param {string} filePath downloaded video
 * @param {Object} opts
 * @param {string} [opts.ffmpegLocation] from findFfmpeg(); defaults to PATH
 * @param {string} [opts.ffprobe]        from findFfprobe()
 * @param {number} [opts.maxRes]         when re-encoding, also cap the smaller
 *   dimension to this (keeps the auto-best size budget so the upload stays
 *   under Telegram's 50 MB bot limit)
 * @param {() => void} [opts.onTranscode] called before a slow re-encode
 * @returns {Promise<IosFixResult>}
 */
export async function ensureIosPlayable(filePath, opts = {}) {
  const ffmpeg = opts.ffmpegLocation || "ffmpeg";
  const info = opts.ffprobe ? await probeMedia(opts.ffprobe, filePath) : null;
  const moovFirst = await moovBeforeMdat(filePath);

  if (!info) {
    // Can't inspect codecs (no ffprobe). Best effort: fix an obviously
    // non-streamable mp4 with a cheap stream copy, otherwise send as-is.
    if (moovFirst === false) {
      const fixed = await ffmpegPass(ffmpeg, filePath, ["-c", "copy"]);
      if (fixed) return { path: fixed, action: "remuxed" };
    }
    return { path: filePath, action: "unchecked" };
  }

  const meta = {
    width: info.width,
    height: info.height,
    duration: info.duration ? Math.round(info.duration) : undefined,
  };

  if (!info.vcodec) {
    return { path: filePath, action: "ok", noVideoStream: true, ...meta };
  }

  const videoOk = info.vcodec === "h264" && IOS_PIX_FMTS.has(info.pixFmt ?? "");
  const audioOk = !info.acodec || info.acodec === "aac";

  if (videoOk && audioOk && info.isMp4 && moovFirst === true) {
    return { path: filePath, action: "ok", ...meta };
  }

  if (videoOk && audioOk) {
    // Right codecs, wrong packaging (moov at the end, or an odd container):
    // stream copy into a faststart mp4. Fast, no quality loss.
    const fixed = await ffmpegPass(ffmpeg, filePath, ["-c", "copy"]);
    if (fixed) return { path: fixed, action: "remuxed", ...meta };
    return { path: filePath, action: "ok", ...meta };
  }

  // Wrong codec somewhere (HEVC/VP9/AV1 video, Opus/MP3 audio, 10-bit…):
  // re-encode only the offending stream(s). This is the slow path — it only
  // runs when a site offered no H.264/AAC stream at all.
  opts.onTranscode?.();
  const args = videoOk
    ? ["-c:v", "copy"]
    : [
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-vf",
        scaleFilter(info, opts.maxRes),
      ];
  args.push(...(audioOk ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "128k"]));

  const fixed = await ffmpegPass(ffmpeg, filePath, args);
  if (!fixed) return { path: filePath, action: "ok", ...meta }; // ffmpeg failed; send what we have
  const outInfo = opts.ffprobe ? await probeMedia(opts.ffprobe, fixed) : null;
  return {
    path: fixed,
    action: "transcoded",
    width: outInfo?.width ?? meta.width,
    height: outInfo?.height ?? meta.height,
    duration: outInfo?.duration ? Math.round(outInfo.duration) : meta.duration,
  };
}

/**
 * Scale filter for the re-encode: cap the smaller dimension at maxRes when
 * the source exceeds it (portrait-aware, never upscales), and always round to
 * the even dimensions libx264 requires.
 */
function scaleFilter(info, maxRes) {
  const minDim = Math.min(info.width ?? 0, info.height ?? 0);
  if (maxRes && minDim > maxRes) {
    const f = maxRes / minDim;
    const w = Math.round((info.width * f) / 2) * 2;
    const h = Math.round((info.height * f) / 2) * 2;
    return `scale=${w}:${h}`;
  }
  return "scale=trunc(iw/2)*2:trunc(ih/2)*2";
}

/**
 * One ffmpeg pass into a fresh faststart mp4 next to the input. Only the
 * first video and (if present) first audio stream are kept — subtitles/data
 * tracks confuse some players and Telegram ignores them anyway.
 * Returns the new path, or null if ffmpeg failed.
 */
async function ffmpegPass(ffmpeg, inputPath, codecArgs) {
  const outPath = inputPath.replace(/(\.[^./\\]+)?$/, "") + ".ios.mp4";
  const { code, stderr } = await run(ffmpeg, [
    "-y",
    "-i",
    inputPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    ...codecArgs,
    "-movflags",
    "+faststart",
    outPath,
  ]).catch((err) => ({ code: -1, stderr: String(err) }));
  if (code !== 0) {
    console.error(
      `ffmpeg iOS fix failed (exit ${code}): ${stderr.split("\n").slice(-4).join(" ")}`
    );
    await fs.rm(outPath, { force: true }).catch(() => {});
    return null;
  }
  return outPath;
}
