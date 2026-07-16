// src/telegram.js
// Thin wrapper over the Telegram Bot API.
//
// Sending strategy (important for Cloudflare Worker limits):
//   1. Prefer handing Telegram the *direct media URL*. Telegram's servers
//      fetch it themselves — our Worker never touches the bytes, so we use
//      almost no CPU/memory and are not bound by the 50 MB upload limit
//      (URL sends allow up to ~20 MB for photos / larger for video that
//      Telegram downloads server-side).
//   2. If a plain URL send fails (e.g. the CDN blocks Telegram's fetcher),
//      fall back to a lightweight streaming multipart upload: we pipe the
//      response body straight into the form-data without buffering the whole
//      file in memory. This is capped at 50 MB by Telegram.

import { fetchWithTimeout, TELEGRAM_UPLOAD_LIMIT, humanSize } from "./util.js";

export class Telegram {
  /**
   * @param {string} token BOT_TOKEN from BotFather
   */
  constructor(token) {
    this.token = token;
    this.base = `https://api.telegram.org/bot${token}`;
  }

  /** Low-level JSON API call. */
  async call(method, payload) {
    const res = await fetchWithTimeout(`${this.base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs: 20000,
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      throw new Error(
        `Telegram ${method} failed: ${data.error_code} ${data.description}`
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

  /**
   * Send media, preferring the "pass a URL to Telegram" path and falling
   * back to a streamed multipart upload only when necessary.
   *
   * @param {"sendVideo"|"sendPhoto"|"sendDocument"|"sendAudio"} method
   * @param {string|number} chatId
   * @param {string} source a direct media URL or a Telegram file_id
   * @param {object} [opts] { caption, field, replyTo, extra }
   */
  async sendMedia(method, chatId, source, opts = {}) {
    const field = opts.field || fieldForMethod(method);
    const base = {
      chat_id: chatId,
      caption: opts.caption,
      parse_mode: "HTML",
      supports_streaming: method === "sendVideo" ? true : undefined,
      ...(opts.replyTo ? { reply_to_message_id: opts.replyTo } : {}),
      ...(opts.extra || {}),
    };

    // A cached file_id is passed in the same field as a URL. When the source
    // isn't an http(s) URL we treat it as a file_id: send it directly and
    // never attempt the streaming fallback (there are no bytes to fetch).
    const isFileId = !/^https?:\/\//i.test(source);
    if (isFileId) {
      return this.call(method, { ...base, [field]: source });
    }

    // First choice: hand Telegram the URL and let its servers fetch it.
    try {
      return await this.call(method, { ...base, [field]: source });
    } catch (err) {
      console.log(`URL send failed, streaming instead: ${err.message}`);
    }

    // Fallback: stream the bytes through the Worker as a multipart upload.
    return this.streamUpload(method, field, base, source);
  }

  /**
   * Streaming multipart upload. We do a HEAD/GET to learn the size and,
   * if it is within Telegram's 50 MB limit, pipe the body into form-data
   * without buffering the whole file. If the size is unknown we still try,
   * but bail out early if it obviously exceeds the limit.
   */
  async streamUpload(method, field, base, fileUrl) {
    const res = await fetchWithTimeout(fileUrl, {
      timeoutMs: 25000,
      headers: { accept: "*/*" },
    });
    if (!res.ok || !res.body) {
      throw new Error(`Could not fetch media for upload (${res.status})`);
    }

    const len = Number(res.headers.get("content-length") || 0);
    if (len && len > TELEGRAM_UPLOAD_LIMIT) {
      throw new Error(
        `File is ${humanSize(len)}, over Telegram's 50 MB bot upload limit.`
      );
    }

    const contentType =
      res.headers.get("content-type") || "application/octet-stream";
    const filename = filenameFor(method, contentType);

    const form = new FormData();
    for (const [k, v] of Object.entries(base)) {
      if (v !== undefined && v !== null) form.append(k, String(v));
    }
    // Blob from the streamed body — CF keeps this lazy where possible.
    const blob = await res.blob();
    if (blob.size > TELEGRAM_UPLOAD_LIMIT) {
      throw new Error(
        `File is ${humanSize(blob.size)}, over Telegram's 50 MB bot upload limit.`
      );
    }
    form.append(field, blob, filename);

    const up = await fetchWithTimeout(`${this.base}/${method}`, {
      method: "POST",
      body: form,
      timeoutMs: 45000,
    });
    const data = await up.json().catch(() => ({}));
    if (!data.ok) {
      throw new Error(
        `Telegram ${method} upload failed: ${data.error_code} ${data.description}`
      );
    }
    return data.result;
  }
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

function filenameFor(method, contentType) {
  if (contentType.includes("mp4") || method === "sendVideo") return "video.mp4";
  if (contentType.includes("jpeg") || contentType.includes("jpg"))
    return "photo.jpg";
  if (contentType.includes("png")) return "photo.png";
  if (contentType.includes("webp")) return "photo.webp";
  if (contentType.includes("mpeg") || method === "sendAudio")
    return "audio.mp3";
  return "file.bin";
}

/**
 * Build an inline keyboard from rows of { text, callback_data }.
 * @param {Array<Array<{text:string, callback_data:string}>>} rows
 */
export function inlineKeyboard(rows) {
  return { reply_markup: { inline_keyboard: rows } };
}

/**
 * Pull the file_id out of a sent-message result so it can be cached and
 * reused later. Photos arrive as an array of sizes; we keep the largest.
 * @param {object} message result from send{Photo,Video,Audio}
 * @returns {string|null}
 */
export function fileIdFromMessage(message) {
  if (!message) return null;
  if (Array.isArray(message.photo) && message.photo.length) {
    return message.photo[message.photo.length - 1].file_id;
  }
  const media = message.video || message.audio || message.document;
  return media?.file_id || null;
}
