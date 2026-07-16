// src/util.js
// Small, dependency-free helpers shared across the worker.

/**
 * Fetch with a timeout so a slow upstream API can never hold a Worker
 * request open long enough to burn our CPU/wall-clock budget.
 *
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
 * Fetch JSON with a timeout and a friendly error if the body is not JSON.
 * @returns {Promise<any>}
 */
export async function fetchJson(url, options = {}) {
  const res = await fetchWithTimeout(url, {
    ...options,
    headers: {
      accept: "application/json",
      "user-agent": DEFAULT_UA,
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Upstream returned non-JSON (${res.status}): ${text.slice(0, 200)}`
    );
  }
  return { ok: res.ok, status: res.status, data };
}

// A realistic desktop UA. Some public parsers reject the default worker UA.
export const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Extract the first http(s) URL from an arbitrary block of text.
 * Telegram messages in groups often wrap the link in other words.
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
