// src/bot.js
//
// Telegram Downloader Bot — Node + yt-dlp + ffmpeg.
//
// Runs as a long-running process (long polling, no webhook/public URL needed).
// Send it any link yt-dlp understands; it probes the available formats, offers
// a quality picker inline, then downloads the chosen format and uploads it.
//
// Required env: BOT_TOKEN
// Optional env: DOWNLOAD_DIR, MAX_FILESIZE_MB

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Telegram, inlineKeyboard } from "./telegram.js";
import { detectPlatform, isProbablyUrl, isAutoBest } from "./platforms.js";
import {
  ensureYtDlp,
  findFfmpeg,
  probe,
  buildChoices,
  buildFastChoice,
  download,
  MAX_FILESIZE_ERROR,
} from "./ytdlp.js";
import { findFfprobe, ensureIosPlayable } from "./media.js";
import {
  findGalleryDl,
  fetchPhotoPost,
  isLikelyPhotoUrl,
  downloadImages,
} from "./photos.js";
import { extractUrl, escapeHtml, humanSize } from "./util.js";

// Marker for "the download produced a file with no video stream" — what a
// photo post looks like to yt-dlp (it grabs just the background music).
const NO_VIDEO_STREAM = "NO_VIDEO_STREAM";

const BOT_TOKEN = process.env.BOT_TOKEN;
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(os.tmpdir(), "tgdl");
// Telegram caps bot uploads at 50 MB; let it be lowered but never raised past it.
const MAX_FILESIZE_MB = Math.min(
  Number(process.env.MAX_FILESIZE_MB) || 50,
  50
);

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is not set. Add it to your environment and retry.");
  process.exit(1);
}

const tg = new Telegram(BOT_TOKEN);

// Resolved once at startup and reused for every download.
let ytdlp;
let ffmpegLocation;
let ffprobeLocation;
let galleryDl;

// Pending download choices, keyed by a short token embedded in callback_data.
// Telegram limits callback_data to 64 bytes, so we can't stuff a URL in there.
// Entries expire so the map can't grow without bound.
const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

function putSession(data) {
  const token = randomUUID().slice(0, 8);
  sessions.set(token, { ...data, expires: Date.now() + SESSION_TTL_MS });
  return token;
}

function getSession(token) {
  const entry = sessions.get(token);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return entry;
}

// Periodically evict expired sessions and their leftover info-json files.
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of sessions) {
    if (entry.expires < now) {
      sessions.delete(token);
      if (entry.infoJsonPath) fs.rm(entry.infoJsonPath, { force: true }).catch(() => {});
    }
  }
}, 5 * 60 * 1000).unref();

async function main() {
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true });

  console.log("Resolving yt-dlp…");
  ytdlp = await ensureYtDlp((m) => console.log(m));
  ffmpegLocation = await findFfmpeg();
  ffprobeLocation = await findFfprobe(ffmpegLocation);
  console.log(
    `yt-dlp ready (${ytdlp}); ffmpeg: ${ffmpegLocation || "on PATH / bundled"}; ffprobe: ${ffprobeLocation || "NOT FOUND"}`
  );
  if (!ffprobeLocation) {
    console.warn(
      "ffprobe not found — videos will be sent without the iOS compatibility check. Install ffmpeg/ffprobe for guaranteed iPhone playback."
    );
  }
  galleryDl = await findGalleryDl();
  if (galleryDl) {
    console.log("gallery-dl found — photo posts enabled");
  } else {
    console.warn(
      "gallery-dl not found — photo posts disabled. Install it with: pip3 install --break-system-packages gallery-dl"
    );
  }

  const me = await tg.call("getMe", {}).catch(() => null);
  if (me) console.log(`Logged in as @${me.username}. Polling…`);

  await pollLoop();
}

/**
 * Long-poll getUpdates forever, dispatching each update. Errors are logged and
 * the loop backs off briefly rather than crashing the process.
 */
async function pollLoop() {
  let offset = 0;
  for (;;) {
    let updates;
    try {
      updates = await tg.getUpdates(offset, 30);
    } catch (err) {
      console.error("getUpdates error:", err.message);
      await sleep(3000);
      continue;
    }
    for (const update of updates) {
      offset = update.update_id + 1;
      // Handle concurrently; a slow download must not block other chats.
      handleUpdate(update).catch((e) =>
        console.error("update error:", e && e.stack ? e.stack : e)
      );
    }
  }
}

// Guard against processing the same message twice. Telegram re-delivers a
// message as an edited_message update when its link preview attaches (and can
// redeliver updates after connection hiccups) — without this, one link was
// downloaded twice in parallel.
const seenMessages = new Set();
function alreadyHandled(msg) {
  const key = `${msg.chat?.id}:${msg.message_id}`;
  if (seenMessages.has(key)) return true;
  seenMessages.add(key);
  if (seenMessages.size > 1000) {
    for (const k of seenMessages) {
      seenMessages.delete(k);
      if (seenMessages.size <= 500) break;
    }
  }
  return false;
}

async function handleUpdate(update) {
  if (update.callback_query) return handleCallback(update.callback_query);
  // Deliberately NOT update.edited_message: an "edit" is usually just the
  // link preview arriving on a message we already processed.
  const msg = update.message;
  if (msg && !alreadyHandled(msg)) return handleMessage(msg);
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || msg.caption || "";

  if (text.startsWith("/start") || text.startsWith("/help")) {
    return tg.sendMessage(chatId, helpText());
  }

  const link = extractUrl(text);
  if (!link || !isProbablyUrl(link)) {
    if (isPrivate(msg)) return tg.sendMessage(chatId, helpText());
    return; // stay quiet on non-link chatter in groups
  }

  const platform = detectPlatform(link);
  const status = await tg
    .sendMessage(chatId, `🔎 Reading ${escapeHtml(platform)} link…`, {
      reply_to_message_id: msg.message_id,
    })
    .catch(() => null);

  // TikTok photo-mode links (/@user/photo/…) can't contain a video — go
  // straight to the photo path instead of a doomed yt-dlp attempt.
  if (isLikelyPhotoUrl(link)) {
    const photo = await tryPhotoPost(chatId, status, link);
    if (!photo.sent) {
      await reportError(
        chatId,
        status,
        photo.error ?? new Error("Couldn't fetch any photos from that post.")
      );
    }
    return;
  }

  // Instagram / TikTok: no quality picker, and no separate metadata probe —
  // a single one-shot yt-dlp run extracts and downloads together, which is
  // roughly half the latency of probe-then-download. Capped 720p H.264 mp4:
  // uploads fast and iPhones can actually play it.
  if (isAutoBest(link)) {
    try {
      await performDownload(chatId, status?.message_id, {
        url: link,
        choice: buildFastChoice(720),
      });
    } catch (err) {
      if (err.message === MAX_FILESIZE_ERROR) {
        return autoBestSmaller(chatId, status, link);
      }
      // Maybe it's a photo post (yt-dlp only saw the background music, or
      // nothing at all). If gallery-dl finds images, send those instead.
      const photo = await tryPhotoPost(chatId, status, link);
      if (photo.sent) return;
      await reportError(chatId, status, pickBestError(err, photo.error, link));
    }
    return;
  }

  let probed;
  try {
    probed = await probe(ytdlp, link);
  } catch (err) {
    // yt-dlp can't handle image posts (tweets with photos, Pinterest pins…);
    // before giving up, see if gallery-dl finds pictures in the link.
    const photo = await tryPhotoPost(chatId, status, link);
    if (photo.sent) return;
    return reportError(chatId, status, pickBestError(err, photo.error, link));
  }

  const choices = buildChoices(probed.info);
  if (!choices.length) {
    await fs.rm(probed.infoJsonPath, { force: true }).catch(() => {});
    return reportError(
      chatId,
      status,
      new Error("No downloadable formats were found for that link.")
    );
  }

  const token = putSession({
    url: link,
    infoJsonPath: probed.infoJsonPath,
    title: probed.info.title,
    choices,
  });

  // One button per choice. callback_data = "dl|<token>|<choiceIndex>".
  const rows = choices.map((c, i) => {
    const over = c.size && c.size > MAX_FILESIZE_MB * 1024 * 1024;
    return [
      {
        text: `${over ? "⚠️ " : ""}${c.label}`,
        callback_data: `dl|${token}|${i}`,
      },
    ];
  });

  const title = probed.info.title
    ? `🎬 <b>${escapeHtml(probed.info.title).slice(0, 200)}</b>\n\n`
    : "";
  const note =
    `${title}Choose a format` +
    (MAX_FILESIZE_MB < 50 || choices.some((c) => c.size && c.size > MAX_FILESIZE_MB * 1024 * 1024)
      ? ` (⚠️ = over the ${MAX_FILESIZE_MB} MB upload limit):`
      : ":");

  if (status) {
    await tg
      .editMessageText(chatId, status.message_id, note, inlineKeyboard(rows))
      .catch(() =>
        tg.sendMessage(chatId, note, inlineKeyboard(rows)).catch(() => {})
      );
  } else {
    await tg.sendMessage(chatId, note, inlineKeyboard(rows)).catch(() => {});
  }
}

async function handleCallback(cq) {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const parts = (cq.data || "").split("|");
  await tg.answerCallbackQuery(cq.id).catch(() => {});

  if (parts[0] !== "dl" || parts.length < 3 || !chatId) return;
  const [, token, indexStr] = parts;
  const session = getSession(token);
  if (!session) {
    if (messageId) {
      await tg
        .editMessageText(chatId, messageId, "⌛ That choice expired — send the link again.")
        .catch(() => {});
    }
    return;
  }
  const choice = session.choices[Number(indexStr)];
  if (!choice) return;

  await runDownload(chatId, messageId, {
    url: session.url,
    infoJsonPath: session.infoJsonPath,
    title: session.title,
    choice,
  });
}

/**
 * runDownload = performDownload + error reporting. Used by the quality-picker
 * callback, where nobody upstream handles failures.
 */
async function runDownload(chatId, messageId, job) {
  try {
    await performDownload(chatId, messageId, job);
  } catch (err) {
    await reportError(chatId, messageId ? { message_id: messageId } : null, err);
  }
}

/**
 * Download one choice to a temp dir and upload it to the chat, editing
 * `messageId` with progress along the way. Shared by the auto-best path (for
 * Instagram/TikTok) and the quality-picker callback. Cleans up its temp dir
 * regardless of outcome; the info-json is owned by the caller. Throws on
 * failure — callers decide between reporting and falling back.
 *
 * Status-message edits are deliberately not awaited: each one costs a
 * Telegram round-trip, and they're cosmetic.
 *
 * @param {string|number} chatId
 * @param {number|undefined} messageId  message to edit with progress, if any
 * @param {{url: string, infoJsonPath?: string, title?: string, choice: import("./ytdlp.js").DownloadChoice}} job
 */
async function performDownload(chatId, messageId, job) {
  const { url, infoJsonPath, choice } = job;

  if (messageId) {
    tg.editMessageText(chatId, messageId, `⏳ Downloading <b>${escapeHtml(choice.label)}</b>…`)
      .catch(() => {});
  }

  // Per-download temp dir so concurrent downloads never clash, and cleanup is
  // a single recursive remove.
  const workDir = path.join(DOWNLOAD_DIR, randomUUID());
  await fs.mkdir(workDir, { recursive: true });

  let lastEdit = 0;
  try {
    const result = await download(
      {
        ytdlp,
        ffmpegLocation,
        url,
        infoJsonPath,
        choice,
        outDir: workDir,
        maxFilesizeMb: MAX_FILESIZE_MB,
      },
      {
        onProgress: (p) => {
          // Throttle edits: Telegram rate-limits, and we don't need every tick.
          const now = Date.now();
          if (now - lastEdit < 3000 || !messageId) return;
          lastEdit = now;
          const pct =
            p.totalBytes && p.totalBytes > 0
              ? Math.floor((p.downloadedBytes / p.totalBytes) * 100)
              : null;
          const bar = pct !== null ? ` ${pct}%` : "";
          const size = p.totalBytes ? ` of ${humanSize(p.totalBytes)}` : "";
          tg.editMessageText(
            chatId,
            messageId,
            `⏳ Downloading <b>${escapeHtml(choice.label)}</b>${bar}${size}`
          ).catch(() => {});
        },
        onProcessing: () => {
          if (!messageId) return;
          tg.editMessageText(
            chatId,
            messageId,
            `⚙️ Processing <b>${escapeHtml(choice.label)}</b>…`
          ).catch(() => {});
        },
      }
    );

    // Guarantee iPhone playback: verify the real file and remux/re-encode it
    // if it isn't H.264/AAC faststart mp4 (see media.js). Also yields real
    // width/height/duration so iOS renders the right aspect ratio.
    let sendPath = result.filePath;
    let videoMeta = {};
    if (choice.kind !== "audio") {
      const fixed = await ensureIosPlayable(result.filePath, {
        ffmpegLocation,
        ffprobe: ffprobeLocation,
        maxRes: choice.maxRes,
        onTranscode: () => {
          if (!messageId) return;
          tg.editMessageText(
            chatId,
            messageId,
            "⚙️ Converting for iPhone playback…"
          ).catch(() => {});
        },
      });
      if (fixed.noVideoStream) {
        // A "video" with no video stream — the photo-post signature.
        throw new Error(NO_VIDEO_STREAM);
      }
      sendPath = fixed.path;
      videoMeta = {
        width: fixed.width ?? result.width,
        height: fixed.height ?? result.height,
        duration: fixed.duration ?? (result.duration ? Math.round(result.duration) : undefined),
      };
    }

    if (messageId) {
      tg.editMessageText(chatId, messageId, "📤 Uploading to Telegram…")
        .catch(() => {});
    }

    const title = job.title ?? result.title;
    const method = choice.kind === "audio" ? "sendAudio" : "sendVideo";
    const caption = title ? `🎞️ ${escapeHtml(title).slice(0, 900)}` : undefined;
    await tg.sendFile(method, chatId, sendPath, { caption, extra: videoMeta });

    if (messageId) tg.deleteMessage(chatId, messageId).catch(() => {});
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function reportError(chatId, status, err) {
  let raw = err && err.message ? err.message : String(err);
  // Internal marker errors must never reach the chat verbatim.
  if (raw === NO_VIDEO_STREAM) {
    raw = "That post doesn't seem to contain a downloadable video.";
  } else if (raw === MAX_FILESIZE_ERROR) {
    raw = `The file is over the ${MAX_FILESIZE_MB} MB bot upload limit.`;
  }
  const message = `😞 Sorry, I couldn't download that.\n<code>${escapeHtml(raw)}</code>`;
  if (status && status.message_id) {
    await tg
      .editMessageText(chatId, status.message_id, message)
      .catch(() => tg.sendMessage(chatId, message).catch(() => {}));
  } else {
    await tg.sendMessage(chatId, message).catch(() => {});
  }
}

/**
 * Rare fallback for the auto-best path: the one-shot 720p download aborted on
 * Telegram's 50 MB limit (a long video). Probe for the duration and retry at
 * a lower resolution so the file fits.
 */
async function autoBestSmaller(chatId, status, link) {
  let probed;
  try {
    probed = await probe(ytdlp, link);
  } catch (err) {
    return reportError(chatId, status, err);
  }
  try {
    const seconds = Number(probed.info?.duration) || 0;
    const cap = seconds > 600 ? 360 : 480;
    await performDownload(chatId, status?.message_id, {
      url: link,
      infoJsonPath: probed.infoJsonPath,
      title: probed.info.title,
      choice: buildFastChoice(cap),
    });
  } catch (err) {
    await reportError(
      chatId,
      status,
      err.message === MAX_FILESIZE_ERROR
        ? new Error(`That video is over the ${MAX_FILESIZE_MB} MB bot upload limit even at reduced quality.`)
        : err
    );
  } finally {
    await fs.rm(probed.infoJsonPath, { force: true }).catch(() => {});
  }
}

// yt-dlp errors that mean "this link isn't a video" rather than "the
// download broke" — for those, the photo attempt's failure is the real story.
const NOT_A_VIDEO_RE =
  /no video|there is no video|no downloadable formats|unsupported url|empty media response/i;

/**
 * After both the video and the photo attempt failed, pick the error the user
 * should actually see. A "no video in this post" from yt-dlp on a photo post
 * is noise — surface why the PHOTOS couldn't be fetched instead, with a
 * cookies hint for Instagram (which rate-limits anonymous access hard).
 */
function pickBestError(videoErr, photoErr, link) {
  const looksLikePhotoPost =
    videoErr.message === NO_VIDEO_STREAM || NOT_A_VIDEO_RE.test(videoErr.message);
  if (!looksLikePhotoPost) return videoErr;
  if (!photoErr) {
    return new Error("That post doesn't seem to contain a downloadable video or photos.");
  }
  let hint = "";
  try {
    if (new URL(link).hostname.includes("instagram")) {
      hint =
        " — Instagram often rate-limits or blocks anonymous photo fetching; adding Instagram login cookies to gallery-dl on the server makes this reliable (see README → Instagram photo posts).";
    }
  } catch {}
  return new Error(`Couldn't fetch the post's photos: ${photoErr.message}${hint}`);
}

/**
 * Try to treat a link as a photo post: ask gallery-dl for image URLs and send
 * them as Telegram photo albums (chunks of 10). Fast path hands Telegram the
 * CDN URLs directly; if Telegram can't fetch them, the images are downloaded
 * and uploaded as files instead.
 *
 * @returns {Promise<{sent: boolean, error?: Error}>} sent=true means the chat
 *   got either the photos or an error report; sent=false means "not a photo
 *   post as far as we can tell" and the caller should report its own error.
 */
async function tryPhotoPost(chatId, status, link) {
  if (!galleryDl) {
    return {
      sent: false,
      error: new Error(
        "This looks like a photo post, but gallery-dl is not installed on the server. Install it with: pip3 install --break-system-packages gallery-dl"
      ),
    };
  }
  const messageId = status?.message_id;
  if (messageId) {
    tg.editMessageText(chatId, messageId, "🖼 Fetching photos…").catch(() => {});
  }

  let post;
  try {
    post = await fetchPhotoPost(galleryDl, link);
  } catch (err) {
    return { sent: false, error: err };
  }
  if (!post.urls.length) return { sent: false };

  const caption = post.title
    ? `🖼 ${escapeHtml(post.title).slice(0, 900)}`
    : undefined;

  try {
    // Fastest path: Telegram's servers fetch the CDN URLs themselves.
    await tg.sendPhotoUrls(chatId, post.urls, { caption });
  } catch {
    // Telegram refused a URL — download the images and upload them ourselves.
    const workDir = path.join(DOWNLOAD_DIR, randomUUID());
    await fs.mkdir(workDir, { recursive: true });
    try {
      const files = await downloadImages(post.urls, workDir, ffmpegLocation || "ffmpeg");
      await tg.sendPhotoFiles(chatId, files, { caption });
    } catch (err) {
      await reportError(chatId, status, err);
      return { sent: true }; // reported — caller shouldn't double-report
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  if (messageId) tg.deleteMessage(chatId, messageId).catch(() => {});
  return { sent: true };
}

function isPrivate(msg) {
  return msg.chat?.type === "private";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function helpText() {
  return [
    "👋 <b>Downloader Bot</b>",
    "",
    "Send me a link from almost any site and I'll fetch the video, photos, or audio:",
    "• <b>Instagram &amp; TikTok</b> — videos grabbed automatically; photo posts arrive as albums",
    "• <b>YouTube, X/Twitter, Reddit</b> and 1,800+ more — pick a quality or audio-only MP3",
    "",
    "Powered by yt-dlp. Files up to 50 MB (Telegram's bot limit).",
    "Works in private chats and groups.",
  ].join("\n");
}

main().catch((err) => {
  console.error("Fatal:", err && err.stack ? err.stack : err);
  process.exit(1);
});
