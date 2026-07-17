// src/util.js
// Small, dependency-free helpers shared across the bot.

/**
 * Fetch with a timeout so a slow Telegram API call can't hang the bot forever.
 * @param {string} url
 * @param {RequestInit & { timeoutMs?: number }} [options]
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, options = {}) {
  const { timeoutMs = 15000, ...init } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract the first http(s) URL from an arbitrary block of text. Group
 * messages often wrap the link in other words.
 * @param {string} text
 * @returns {string|null}
 */
export function extractUrl(text) {
  if (!text) return null;
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  return match ? match[0].replace(/[.,);]+$/, "") : null;
}

/**
 * Escape text for Telegram's HTML parse mode.
 * @param {string} s
 */
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Human-readable byte size.
 * @param {number} bytes
 */
export function humanSize(bytes) {
  if (!bytes || bytes < 0) return "unknown";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

// Telegram's hard limit for a bot uploading a file by multipart is 50 MB.
export const TELEGRAM_UPLOAD_LIMIT = 50 * 1024 * 1024;
