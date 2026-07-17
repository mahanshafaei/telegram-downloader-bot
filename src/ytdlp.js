// src/ytdlp.js
//
// The download engine — a straight port of yoink's yt-dlp wrapper
// (https://github.com/…/yoink) to plain Node, minus the terminal UI bits.
//
// It resolves a usable yt-dlp binary (system install first, then a copy we
// download from GitHub releases), finds ffmpeg for merging/mp3, probes a link
// for its formats, and spawns yt-dlp to download a chosen format to disk.
//
// yt-dlp does the heavy lifting for 1,800+ sites, so the bot inherits all of
// them: YouTube, X/Twitter, Instagram, TikTok, Threads, Reddit, and so on.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { humanSize } from "./util.js";

const BIN_DIR = path.join(os.homedir(), ".telegram-downloader", "bin");
const RELEASE_BASE =
  "https://github.com/yt-dlp/yt-dlp/releases/latest/download";

function ytDlpAssetName() {
  if (process.platform === "win32") return "yt-dlp.exe";
  if (process.platform === "darwin") return "yt-dlp_macos";
  return process.arch === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux";
}

// Spawn a command just to see whether it runs. Async on purpose so we never
// block while probing for a binary.
function commandWorks(cmd, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: "ignore", timeout: 10_000 });
    } catch {
      resolve(false);
      return;
    }
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Resolve a usable yt-dlp binary: system install first, then a previously
 * downloaded copy, then download the standalone binary from GitHub releases.
 * @param {(message: string) => void} [onStatus]
 * @returns {Promise<string>} path or command name
 */
export async function ensureYtDlp(onStatus = () => {}) {
  if (await commandWorks("yt-dlp", ["--version"])) return "yt-dlp";

  const local = path.join(
    BIN_DIR,
    process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
  );
  if (await commandWorks(local, ["--version"])) return local;

  onStatus("first run: fetching yt-dlp…");
  await fs.mkdir(BIN_DIR, { recursive: true });

  const url = `${RELEASE_BASE}/${ytDlpAssetName()}`;
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(
      `Could not download yt-dlp (${response.status}). Check the connection and try again.`
    );
  }

  const tmp = `${local}.download`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(tmp));
  await fs.chmod(tmp, 0o755).catch(() => {});
  await fs.rename(tmp, local);
  return local;
}

/**
 * Find ffmpeg for stream merging / mp3 extraction. Returns undefined when it's
 * already on PATH (yt-dlp finds it itself) or genuinely absent.
 * @returns {Promise<string | undefined>}
 */
export async function findFfmpeg() {
  if (await commandWorks("ffmpeg", ["-version"])) return undefined;
  try {
    const mod = await import("ffmpeg-static");
    const ffmpegPath = mod.default ?? mod;
    if (ffmpegPath && (await commandWorks(ffmpegPath, ["-version"]))) {
      return ffmpegPath;
    }
  } catch {
    // ffmpeg-static not installed — fine, single-file formats still work.
  }
  return undefined;
}

/**
 * @typedef {Object} VideoInfo
 * @property {string} title
 * @property {string} [uploader]
 * @property {number} [duration]
 * @property {string} [webpage_url]
 * @property {string} [extractor_key]
 * @property {RawFormat[]} [formats]
 */

/**
 * Probe a link for its metadata and available formats via `yt-dlp -J`.
 * @param {string} ytdlp
 * @param {string} url
 * @returns {Promise<{ info: VideoInfo, infoJsonPath: string }>}
 */
export async function probe(ytdlp, url) {
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(ytdlp, ["-J", "--no-playlist", "--no-warnings", url]);
    let out = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(cleanYtDlpError(stderr) || `yt-dlp exited with code ${code}`)
        );
      } else {
        resolve(out);
      }
    });
  });

  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new Error("Could not parse video info from yt-dlp.");
  }

  const infoJsonPath = path.join(
    os.tmpdir(),
    `tgdl-info-${process.pid}-${Date.now()}.json`
  );
  await fs.writeFile(infoJsonPath, stdout);
  return { info, infoJsonPath };
}

/**
 * @typedef {Object} RawFormat
 * @property {string} format_id
 * @property {string} [ext]
 * @property {string} [vcodec]
 * @property {string} [acodec]
 * @property {number} [height]
 * @property {number} [width]
 * @property {number} [abr]
 * @property {number} [tbr]
 * @property {number} [filesize]
 * @property {number} [filesize_approx]
 */

/**
 * @typedef {Object} DownloadChoice
 * @property {string} label     shown on the inline-keyboard button
 * @property {"video"|"audio"} kind
 * @property {number} [size]    estimated bytes, when yt-dlp reports it
 * @property {string[]} args    format-selection args passed to yt-dlp
 */

const MAX_VIDEO_CHOICES = 8;

/**
 * Turn a probed VideoInfo into a list of download choices, one per distinct
 * resolution plus an audio-only mp3. Ported from yoink's buildChoices, with
 * the estimated size kept as a number so the caller can flag >50 MB picks.
 * @param {VideoInfo} info
 * @returns {DownloadChoice[]}
 */
export function buildChoices(info) {
  const formats = info.formats ?? [];
  const choices = [];

  const audioOnly = formats.filter(
    (f) => f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none")
  );
  const bestAudio = [...audioOnly].sort(
    (a, b) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0)
  )[0];
  const audioSize = bestAudio?.filesize ?? bestAudio?.filesize_approx;

  const videos = formats.filter(
    (f) => f.vcodec && f.vcodec !== "none" && f.height
  );
  const heights = [...new Set(videos.map((f) => f.height))].sort(
    (a, b) => b - a
  );

  for (const height of heights.slice(0, MAX_VIDEO_CHOICES)) {
    const candidates = videos.filter((f) => f.height === height);
    const best = [...candidates].sort((a, b) => scoreVideo(b) - scoreVideo(a))[0];
    const muxed = best.acodec && best.acodec !== "none";
    const size =
      (best.filesize ?? best.filesize_approx ?? 0) +
      (muxed ? 0 : audioSize ?? 0);
    const sizeLabel = size > 0 ? ` · ~${humanSize(size)}` : "";
    choices.push({
      kind: "video",
      label: `${height}p · mp4${sizeLabel}`,
      size: size || undefined,
      args: [
        "-f",
        `bv*[height=${height}]+ba/b[height=${height}]/bv*[height<=${height}]+ba/b`,
        "--merge-output-format",
        "mp4",
      ],
    });
  }

  if (choices.length === 0) {
    choices.push({
      kind: "video",
      label: "best available · mp4",
      args: ["-f", "bv*+ba/b", "--merge-output-format", "mp4"],
    });
  }

  const audioSizeLabel = audioSize ? ` · ~${humanSize(audioSize)}` : "";
  choices.push({
    kind: "audio",
    label: `audio only · mp3${audioSizeLabel}`,
    size: audioSize || undefined,
    args: ["-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "0"],
  });

  return choices;
}

function scoreVideo(f) {
  let score = f.tbr ?? 0;
  if (f.ext === "mp4") score += 10_000;
  if (f.vcodec?.startsWith("avc")) score += 5_000;
  return score;
}

const PROGRESS_PREFIX = "TGDL|";
const PROGRESS_TEMPLATE = `${PROGRESS_PREFIX}%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s`;

/**
 * @typedef {Object} DownloadProgress
 * @property {number} downloadedBytes
 * @property {number} [totalBytes]
 * @property {number} [speed]
 * @property {number} [eta]
 */

/**
 * Download one chosen format to `outDir` and resolve with the final file path.
 * Adapted from yoink's download(): same yt-dlp invocation and progress parsing,
 * with the Ink handlers reduced to a couple of optional callbacks.
 *
 * @param {Object} opts
 * @param {string} opts.ytdlp
 * @param {string} [opts.ffmpegLocation]
 * @param {string} opts.url
 * @param {string} [opts.infoJsonPath]  reuse probe metadata for a faster start
 * @param {DownloadChoice} opts.choice
 * @param {string} opts.outDir
 * @param {number} [opts.maxFilesizeMb]  abort if yt-dlp sees a bigger file
 * @param {Object} [handlers]
 * @param {(p: DownloadProgress) => void} [handlers.onProgress]
 * @param {() => void} [handlers.onProcessing]
 * @returns {Promise<string>} absolute path to the downloaded file
 */
export function download(opts, handlers = {}) {
  const onProgress = handlers.onProgress ?? (() => {});
  const onProcessing = handlers.onProcessing ?? (() => {});

  const args = [
    ...(opts.infoJsonPath
      ? ["--load-info-json", opts.infoJsonPath]
      : [opts.url]),
    ...opts.choice.args,
    "--no-playlist",
    "--no-warnings",
    "--newline",
    // --print implies --quiet, which would hide the progress and
    // [Merger]/[ExtractAudio] lines we rely on — force them back on.
    "--no-quiet",
    "--progress",
    "--progress-template",
    `download:${PROGRESS_TEMPLATE}`,
    "--print",
    "after_move:filepath",
    "--no-simulate",
    "-o",
    path.join(opts.outDir, "%(title).60s.%(ext)s"),
  ];
  if (opts.maxFilesizeMb) {
    args.push("--max-filesize", `${opts.maxFilesizeMb}M`);
  }
  if (opts.ffmpegLocation) {
    args.push("--ffmpeg-location", opts.ffmpegLocation);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(opts.ytdlp, args);

    let stderr = "";
    let filepath = "";
    let buffer = "";
    const destinations = [];

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith(PROGRESS_PREFIX)) {
          const [downloaded, total, totalEstimate, speed, eta] = line
            .slice(PROGRESS_PREFIX.length)
            .split("|");
          const downloadedBytes = toNumber(downloaded) ?? 0;
          onProgress({
            downloadedBytes,
            totalBytes: toNumber(total) ?? toNumber(totalEstimate),
            speed: toNumber(speed),
            eta: toNumber(eta),
          });
        } else if (line.includes("[Merger]") || line.includes("[ExtractAudio]")) {
          const merging = /^\[Merger\] Merging formats into "(.+)"$/.exec(
            line
          )?.[1];
          const extracting = /^\[ExtractAudio\] Destination: (.+)$/.exec(
            line
          )?.[1];
          const target = merging ?? extracting;
          if (target) destinations.push(target);
          onProcessing();
        } else if (line.startsWith("[download] Destination: ")) {
          destinations.push(line.slice("[download] Destination: ".length));
        } else if (path.isAbsolute(line)) {
          filepath = line;
        }
      }
    });

    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && filepath) {
        resolve(filepath);
      } else {
        reject(
          new Error(
            cleanYtDlpError(stderr) || `Download failed (yt-dlp exit code ${code}).`
          )
        );
      }
    });

    // destinations are tracked so a failed run can be cleaned up by the caller;
    // yt-dlp's --print after_move:filepath gives us the final path on success.
    void destinations;
  });
}

function toNumber(value) {
  if (!value || value === "NA" || value === "None") return undefined;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : undefined;
}

// yt-dlp prints many lines; surface only the final ERROR: line, trimmed of its
// "[extractor]" prefix, so chat error messages stay readable.
function cleanYtDlpError(stderr) {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("ERROR:"));
  const last = lines.at(-1);
  return last ? last.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, "") : "";
}
