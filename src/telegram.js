// src/telegram.js
// Thin wrapper over the Telegram Bot API for the Node/yt-dlp bot.
//
// Unlike the old Worker version (which handed Telegram a URL to fetch), this
// bot downloads files to disk with yt-dlp and uploads the bytes itself. That
// means every upload is bound by Telegram's 50 MB bot-upload limit.

import fs from "node:fs";
import { basename } from "node:path";
import { fetchWithTimeout, TELEGRAM_UPLOAD_LIMIT, humanSize } from "./util.js";

const API = "https://api.telegram.org";

export class Telegram {
  /**
   * @param {string} token BOT_TOKEN from BotFather
   * @param {string} [apiBase] override for tests / self-hosted Bot API servers
   */
  constructor(token, apiBase = API) {
    this.token = token;
    this.base = `${apiBase}/bot${token}`;
  }

  /** Low-level JSON API call. */
  async call(method, payload) {
    const res = await fetchWithTimeout(`${this.base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs: 30000,
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      throw new Error(
        `Telegram ${method} failed: ${data.error_code} ${data.description}`
      );
    }
    return data.result;
  }

  /**
   * Long-poll for updates. Returns an array of Update objects.
   * @param {number} offset  next update_id to fetch
   * @param {number} timeout seconds to hold the connection open
   */
  async getUpdates(offset, timeout = 30) {
    const res = await fetchWithTimeout(`${this.base}/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        offset,
        timeout,
        allowed_updates: ["message", "edited_message", "callback_query"],
      }),
      // a touch longer than the long-poll timeout so the socket doesn't drop
      timeoutMs: (timeout + 10) * 1000,
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      throw new Error(
        `Telegram getUpdates failed: ${data.error_code} ${data.description}`
      );
    }
    return data.result;
  }

  sendMessage(chatId, text, extra = {}) {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra,
    });
  }

  answerCallbackQuery(id, text = "", extra = {}) {
    return this.call("answerCallbackQuery", {
      callback_query_id: id,
      text,
      ...extra,
    });
  }

  editMessageText(chatId, messageId, text, extra = {}) {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      ...extra,
    });
  }

  deleteMessage(chatId, messageId) {
    return this.call("deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
  }

  /**
   * Upload a local file to Telegram as a video, audio, or document.
   * Rejects before uploading if the file is over the 50 MB bot limit.
   *
   * @param {"sendVideo"|"sendAudio"|"sendDocument"|"sendPhoto"} method
   * @param {string|number} chatId
   * @param {string} filePath absolute path to the file on disk
   * @param {object} [opts] { caption, replyTo, extra }
   */
  async sendFile(method, chatId, filePath, opts = {}) {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > TELEGRAM_UPLOAD_LIMIT) {
      throw new Error(
        `File is ${humanSize(stat.size)}, over Telegram's 50 MB bot upload limit. Try a lower quality.`
      );
    }

    const field = fieldForMethod(method);
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (opts.caption) {
      form.append("caption", opts.caption);
      form.append("parse_mode", "HTML");
    }
    if (method === "sendVideo") form.append("supports_streaming", "true");
    if (opts.replyTo) form.append("reply_to_message_id", String(opts.replyTo));
    for (const [k, v] of Object.entries(opts.extra || {})) {
      if (v !== undefined && v !== null) form.append(k, String(v));
    }

    // Node 20's fs.openAsBlob streams the file rather than buffering it all.
    const blob = await fs.openAsBlob(filePath);
    form.append(field, blob, basename(filePath));

    // Uploads can be slow from a datacenter host; give them room so a large-ish
    // file isn't cut off mid-transfer (the "operation was aborted" error).
    return this.callForm(method, form);
  }

  /**
   * Send photos the fastest way possible: by URL. Telegram's servers fetch
   * the images themselves, so nothing is downloaded to or uploaded from the
   * bot host. 2–10 photos become one album (sendMediaGroup); a single photo
   * uses sendPhoto; >10 are split into consecutive albums. Throws if
   * Telegram can't fetch the URLs — callers fall back to sendPhotoFiles.
   *
   * @param {string|number} chatId
   * @param {string[]} urls   direct image URLs
   * @param {object} [opts]   { caption } (HTML, shown on the first photo)
   */
  async sendPhotoUrls(chatId, urls, opts = {}) {
    for (const [i, chunk] of chunked(urls, 10).entries()) {
      const caption = i === 0 ? opts.caption : undefined;
      if (chunk.length === 1) {
        await this.call("sendPhoto", {
          chat_id: chatId,
          photo: chunk[0],
          ...(caption ? { caption, parse_mode: "HTML" } : {}),
        });
      } else {
        await this.call("sendMediaGroup", {
          chat_id: chatId,
          media: chunk.map((url, j) => ({
            type: "photo",
            media: url,
            // Caption on exactly one item = album-level caption in clients.
            ...(caption && j === 0 ? { caption, parse_mode: "HTML" } : {}),
          })),
        });
      }
    }
  }

  /**
   * Upload local image files as albums (multipart, attach://). Fallback for
   * when Telegram refuses to fetch the CDN URLs itself.
   *
   * @param {string|number} chatId
   * @param {string[]} files  paths to jpg/png images on disk
   * @param {object} [opts]   { caption }
   */
  async sendPhotoFiles(chatId, files, opts = {}) {
    for (const [i, chunk] of chunked(files, 10).entries()) {
      const caption = i === 0 ? opts.caption : undefined;
      const form = new FormData();
      form.append("chat_id", String(chatId));
      if (chunk.length === 1) {
        if (caption) {
          form.append("caption", caption);
          form.append("parse_mode", "HTML");
        }
        form.append("photo", await fs.openAsBlob(chunk[0]), basename(chunk[0]));
        await this.callForm("sendPhoto", form);
      } else {
        const media = [];
        for (const [j, file] of chunk.entries()) {
          form.append(`photo${j}`, await fs.openAsBlob(file), basename(file));
          media.push({
            type: "photo",
            media: `attach://photo${j}`,
            ...(caption && j === 0 ? { caption, parse_mode: "HTML" } : {}),
          });
        }
        form.append("media", JSON.stringify(media));
        await this.callForm("sendMediaGroup", form);
      }
    }
  }

  /** Multipart API call (shared by sendFile and the photo senders). */
  async callForm(method, form, timeoutMs = 300000) {
    const res = await fetchWithTimeout(`${this.base}/${method}`, {
      method: "POST",
      body: form,
      timeoutMs,
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      throw new Error(
        `Telegram ${method} upload failed: ${data.error_code} ${data.description}`
      );
    }
    return data.result;
  }
}

/** Split an array into consecutive chunks of at most `size` items. */
function chunked(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function fieldForMethod(method) {
  switch (method) {
    case "sendVideo":
      return "video";
    case "sendPhoto":
      return "photo";
    case "sendAudio":
      return "audio";
    default:
      return "document";
  }
}

/**
 * Build an inline keyboard from rows of { text, callback_data }.
 * @param {Array<Array<{text:string, callback_data:string}>>} rows
 */
export function inlineKeyboard(rows) {
  return { reply_markup: { inline_keyboard: rows } };
}
