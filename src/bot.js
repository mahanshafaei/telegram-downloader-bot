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
import { ensureYtDlp, findFfmpeg, probe, buildChoices, download } from "./ytdlp.js";
import { extractUrl, escapeHtml, humanSize } from "./util.js";

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
  console.log(
    `yt-dlp ready (${ytdlp}); ffmpeg: ${ffmpegLocation || "on PATH / bundled"}`
  );

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

async function handleUpdate(update) {
  if (update.callback_query) return handleCallback(update.callback_query);
  const msg = update.message || update.edited_message;
  if (msg) return handleMessage(msg);
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

  let probed;
  try {
    probed = await probe(ytdlp, link);
  } catch (err) {
    return reportError(chatId, status, err);
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

  // Instagram / TikTok: skip the picker, grab the best video straight away.
  if (isAutoBest(link)) {
    const best =
      choices.find((c) => c.kind === "video") ?? choices[0];
    try {
      await runDownload(chatId, status?.message_id, {
        url: link,
        infoJsonPath: probed.infoJsonPath,
        title: probed.info.title,
        choice: best,
      });
    } finally {
      await fs.rm(probed.infoJsonPath, { force: true }).catch(() => {});
    }
    return;
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
 * Download one choice to a temp dir and upload it to the chat, editing
 * `messageId` with progress along the way. Shared by the auto-best path (for
 * Instagram/TikTok) and the quality-picker callback. Cleans up its temp dir
 * regardless of outcome; the info-json is owned by the caller.
 *
 * @param {string|number} chatId
 * @param {number|undefined} messageId  message to edit with progress, if any
 * @param {{url: string, infoJsonPath?: string, title?: string, choice: import("./ytdlp.js").DownloadChoice}} job
 */
async function runDownload(chatId, messageId, job) {
  const { url, infoJsonPath, title, choice } = job;

  if (messageId) {
    await tg
      .editMessageText(chatId, messageId, `⏳ Downloading <b>${escapeHtml(choice.label)}</b>…`)
      .catch(() => {});
  }

  // Per-download temp dir so concurrent downloads never clash, and cleanup is
  // a single recursive remove.
  const workDir = path.join(DOWNLOAD_DIR, randomUUID());
  await fs.mkdir(workDir, { recursive: true });

  let lastEdit = 0;
  try {
    const filePath = await download(
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

    if (messageId) {
      await tg
        .editMessageText(chatId, messageId, "📤 Uploading to Telegram…")
        .catch(() => {});
    }

    const method = choice.kind === "audio" ? "sendAudio" : "sendVideo";
    const caption = title ? `🎞️ ${escapeHtml(title).slice(0, 900)}` : undefined;
    await tg.sendFile(method, chatId, filePath, { caption });

    if (messageId) await tg.deleteMessage(chatId, messageId).catch(() => {});
  } catch (err) {
    await reportError(chatId, messageId ? { message_id: messageId } : null, err);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function reportError(chatId, status, err) {
  const raw = err && err.message ? err.message : String(err);
  const message = `😞 Sorry, I couldn't download that.\n<code>${escapeHtml(raw)}</code>`;
  if (status && status.message_id) {
    await tg
      .editMessageText(chatId, status.message_id, message)
      .catch(() => tg.sendMessage(chatId, message).catch(() => {}));
  } else {
    await tg.sendMessage(chatId, message).catch(() => {});
  }
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
    "Send me a link from almost any site and I'll fetch the video or audio:",
    "• <b>Instagram &amp; TikTok</b> — grabbed at best quality automatically",
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
