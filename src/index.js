// src/index.js
//
// Telegram Downloader Bot — Cloudflare Worker (ES Modules).
//
// Supports Instagram (reels + images), TikTok (watermark-free), Pinterest
// (images + video), and YouTube (with inline quality selection). Works in
// both private chats and groups.
//
// Routes:
//   POST /            -> Telegram webhook (also accepts /webhook)
//   GET  /            -> health check
//
// Required env: BOT_TOKEN
// Optional env: WEBHOOK_SECRET, COBALT_API_URL, COBALT_API_KEY

import { Telegram, inlineKeyboard, fileIdFromMessage } from "./telegram.js";
import {
  detectPlatform,
  resolve,
  cobaltResolve,
  youtubeId,
  Platform,
} from "./resolvers.js";
import { cacheKey, getCached, putCached } from "./cache.js";
import { extractUrl, escapeHtml } from "./util.js";

const YT_QUALITIES = ["360", "720", "1080"];

// Open the Worker URL in a browser to see which build is live.
const VERSION = "v8-file-cache";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- Health check ---
    if (request.method === "GET") {
      const instances = env.COBALT_API_URL || "(defaults in code)";
      const cache = env.MEDIA_CACHE ? "on" : "off";
      return new Response(
        `Telegram Downloader Bot is running.\n` +
          `version: ${VERSION}\n` +
          `cobalt: ${instances}\n` +
          `file_id cache: ${cache}\n`,
        { headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // --- Secret token verification (defense against forged webhook calls) ---
    if (env.WEBHOOK_SECRET) {
      const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (got !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
    }

    if (!env.BOT_TOKEN) {
      console.error("BOT_TOKEN is not configured.");
      return new Response("Server misconfigured", { status: 500 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    const tg = new Telegram(env.BOT_TOKEN);

    // Process asynchronously but keep the worker alive until done, while
    // returning 200 to Telegram immediately so it doesn't retry/timeout.
    ctx.waitUntil(handleUpdate(update, tg, env).catch((e) => {
      console.error("Unhandled update error:", e && e.stack ? e.stack : e);
    }));

    return new Response("OK");
  },
};

/**
 * Route a single Telegram update.
 */
async function handleUpdate(update, tg, env) {
  if (update.callback_query) {
    return handleCallback(update.callback_query, tg, env);
  }
  const msg = update.message || update.channel_post || update.edited_message;
  if (msg) return handleMessage(msg, tg, env);
}

/**
 * Handle an incoming text message (DM, group, or channel post).
 */
async function handleMessage(msg, tg, env) {
  const chatId = msg.chat.id;
  const text = msg.text || msg.caption || "";

  // Commands.
  if (text.startsWith("/start") || text.startsWith("/help")) {
    return tg.sendMessage(chatId, helpText());
  }

  const link = extractUrl(text);
  if (!link) {
    // In groups, stay silent on non-link chatter. In DMs, gently guide.
    if (isPrivate(msg)) return tg.sendMessage(chatId, helpText());
    return;
  }

  const platform = detectPlatform(link);
  if (!platform) {
    if (isPrivate(msg)) {
      return tg.sendMessage(
        chatId,
        "🤔 I don't recognize that link. I support Instagram, TikTok, Pinterest and YouTube."
      );
    }
    return; // ignore unknown links in groups to avoid noise
  }

  // YouTube -> offer quality choices via inline keyboard.
  if (platform === Platform.YOUTUBE) {
    const id = youtubeId(link);
    if (!id) {
      return tg.sendMessage(chatId, "⚠️ Couldn't parse that YouTube link.");
    }
    const rows = [
      YT_QUALITIES.map((q) => ({
        text: `${q}p`,
        // callback_data is well under Telegram's 64-byte limit:
        // "yt|" (3) + id (11) + "|" (1) + quality (<=4) = ~19 bytes.
        callback_data: `yt|${id}|${q}`,
      })),
      [{ text: "🎵 Audio (MP3)", callback_data: `yt|${id}|audio` }],
    ];
    return tg.sendMessage(
      chatId,
      "🎬 Choose a quality:",
      {
        ...inlineKeyboard(rows),
        reply_to_message_id: msg.message_id,
      }
    );
  }

  // Everything else: resolve + send immediately.
  const status = await tg
    .sendMessage(chatId, "⏳ Fetching media…", {
      reply_to_message_id: msg.message_id,
    })
    .catch(() => null);

  try {
    const key = cacheKey(platform, link);
    await deliver(tg, chatId, env, key, () => resolve(env, platform, link), msg.message_id);
    if (status) await tg.call("deleteMessage", {
      chat_id: chatId,
      message_id: status.message_id,
    }).catch(() => {});
  } catch (err) {
    await reportError(tg, chatId, status, err);
  }
}

/**
 * Handle a YouTube quality selection (callback_query).
 */
async function handleCallback(cq, tg, env) {
  const data = cq.data || "";
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;

  // Acknowledge quickly so Telegram removes the "loading" spinner.
  await tg.answerCallbackQuery(cq.id, "Working on it…").catch(() => {});

  const parts = data.split("|");
  if (parts[0] !== "yt" || parts.length < 3 || !chatId) {
    return;
  }
  const [, id, quality] = parts;
  const audioOnly = quality === "audio";
  const ytUrl = `https://www.youtube.com/watch?v=${id}`;

  if (messageId) {
    await tg
      .editMessageText(
        chatId,
        messageId,
        `⏳ Preparing ${audioOnly ? "audio" : quality + "p"}…`
      )
      .catch(() => {});
  }

  try {
    const key = cacheKey(Platform.YOUTUBE, id, quality);
    await deliver(
      tg,
      chatId,
      env,
      key,
      () =>
        cobaltResolve(env, ytUrl, {
          quality: audioOnly ? undefined : quality,
          audioOnly,
        })
    );
    if (messageId) {
      await tg
        .call("deleteMessage", { chat_id: chatId, message_id: messageId })
        .catch(() => {});
    }
  } catch (err) {
    const note = `❌ Couldn't get that quality.\n<code>${escapeHtml(
      err.message || String(err)
    )}</code>`;
    if (messageId) {
      await tg.editMessageText(chatId, messageId, note).catch(() => {});
    } else {
      await tg.sendMessage(chatId, note).catch(() => {});
    }
  }
}

/**
 * Deliver media for a link, using the file_id cache when it's available.
 *
 * On a cache hit the stored file_ids are re-sent straight from Telegram's
 * storage. On a miss we run `produce()` to resolve the link, send the media by
 * URL, then remember the resulting file_ids for next time. Caching is skipped
 * entirely when no KV namespace is bound (see cache.js).
 *
 * @param {Telegram} tg
 * @param {string|number} chatId
 * @param {object} env
 * @param {string|null} key       cache key, or null to bypass the cache
 * @param {() => Promise<object>} produce  resolves the link on a cache miss
 * @param {number} [replyTo]      message id to reply to
 */
async function deliver(tg, chatId, env, key, produce, replyTo) {
  if (key) {
    const cached = await getCached(env, key);
    if (cached && cached.items && cached.items.length) {
      await sendItems(tg, chatId, cached, replyTo);
      return;
    }
  }

  const result = await produce();
  const sendable = (result.items || []).filter((i) => i && i.url);
  const fileIds = await sendItems(tg, chatId, result, replyTo);

  // Only cache when every item came back with a reusable file_id. A partial
  // result would replay incompletely on the next request.
  if (key && fileIds.length === sendable.length && fileIds.length > 0) {
    await putCached(env, key, { title: result.title, items: fileIds });
  }
}

/**
 * Send every media item to the chat, picking the right method per type.
 * Returns the file_id of each sent item (largest size for photos), so callers
 * can cache them. The `url` field carries either a direct URL or a file_id;
 * sendMedia treats anything that isn't http(s) as a file_id.
 *
 * @returns {Promise<Array<{type: string, url: string}>>}
 */
async function sendItems(tg, chatId, result, replyTo) {
  const items = (result.items || []).filter((i) => i && i.url);
  if (!items.length) {
    throw new Error("No downloadable media was found for that link.");
  }

  const caption = result.title
    ? `🎞️ ${escapeHtml(result.title).slice(0, 900)}`
    : undefined;

  const sent = [];
  let captionUsed = false;
  for (const item of items) {
    const method =
      item.type === "photo"
        ? "sendPhoto"
        : item.type === "audio"
        ? "sendAudio"
        : "sendVideo";
    const message = await tg.sendMedia(method, chatId, item.url, {
      caption: captionUsed ? undefined : caption,
      replyTo,
    });
    captionUsed = true;
    const fileId = fileIdFromMessage(message);
    if (fileId) sent.push({ type: item.type, url: fileId });
  }
  return sent;
}

async function reportError(tg, chatId, status, err) {
  const message = `😞 Sorry, I couldn't download that.\n<code>${escapeHtml(
    err.message || String(err)
  )}</code>`;
  if (status) {
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

function helpText() {
  return [
    "👋 <b>Downloader Bot</b>",
    "",
    "Send me a link and I'll fetch the media:",
    "• <b>Instagram</b> — reels &amp; photos",
    "• <b>TikTok</b> — watermark-free videos",
    "• <b>Pinterest</b> — images &amp; videos",
    "• <b>YouTube</b> — pick a quality (360p/720p/1080p or audio)",
    "",
    "Works in private chats and groups.",
  ].join("\n");
}
