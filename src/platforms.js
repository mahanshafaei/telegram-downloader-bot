// src/platforms.js
// Recognises which site a link belongs to, purely for nicer labels in the
// chat. yt-dlp handles the actual extraction and supports 1,800+ sites, so an
// "unknown" host here is fine — we still try to download it.

const PLATFORMS = [
  { hosts: ["youtube.com", "youtu.be", "music.youtube.com"], label: "YouTube" },
  { hosts: ["x.com", "twitter.com"], label: "X / Twitter" },
  { hosts: ["instagram.com"], label: "Instagram" },
  { hosts: ["threads.net", "threads.com"], label: "Threads" },
  { hosts: ["tiktok.com"], label: "TikTok" },
  { hosts: ["pinterest.com", "pin.it"], label: "Pinterest" },
  { hosts: ["vimeo.com"], label: "Vimeo" },
  { hosts: ["twitch.tv"], label: "Twitch" },
  { hosts: ["reddit.com"], label: "Reddit" },
  { hosts: ["facebook.com", "fb.watch"], label: "Facebook" },
];

/**
 * Best-effort friendly name for a link's host. Returns the bare hostname for
 * anything not in the list above (yt-dlp may still handle it).
 * @param {string} url
 * @returns {string}
 */
export function detectPlatform(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return "Unknown site";
  }
  for (const { hosts, label } of PLATFORMS) {
    if (hosts.some((h) => hostname === h || hostname.endsWith(`.${h}`))) {
      return label;
    }
  }
  return hostname.replace(/^www\./, "");
}

// Hosts where a quality picker just adds friction: they're single short
// videos, so we grab the best quality straight away instead of asking.
const AUTO_BEST_HOSTS = ["instagram.com", "tiktok.com"];

/**
 * True when a link should download at best quality without prompting.
 * @param {string} url
 */
export function isAutoBest(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return AUTO_BEST_HOSTS.some(
    (h) => hostname === h || hostname.endsWith(`.${h}`)
  );
}

/**
 * True if the string is an http(s) URL.
 * @param {string} input
 */
export function isProbablyUrl(input) {
  try {
    const u = new URL(String(input).trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
