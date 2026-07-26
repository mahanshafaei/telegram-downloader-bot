// src/instagram.js
//
// Direct Instagram photo extraction over the same private web API yt-dlp
// uses when login cookies are present:
//
//   GET https://i.instagram.com/api/v1/media/{pk}/info/
//   X-IG-App-ID: 936619743392459 (+ a few sibling headers) + session cookies
//
// yt-dlp calls this endpoint for VIDEO posts and it demonstrably works with
// the bot's cookies — but for photo posts yt-dlp bails out ("There is no
// video in this post") even though the very same response carries the images
// in image_versions2/carousel_media. This module makes that one request and
// keeps the images. gallery-dl remains the fallback (and handles other
// sites); this path is primary for Instagram because it is the one whose
// auth flow is proven to work.

import fs from "node:fs/promises";
import { BROWSER_UA } from "./util.js";

// Instagram's shortcode alphabet (base-64, URL-safe variant, custom order).
const ENCODING_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const API_BASE = "https://i.instagram.com/api/v1";

/**
 * Extract the post shortcode from any Instagram post URL form:
 * /p/{sc}/, /reel/{sc}/, /reels/{sc}/, /tv/{sc}/, /{user}/p/{sc}/.
 * Returns null for non-Instagram or non-post URLs.
 */
export function shortcodeFromUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (host !== "instagram.com" && !host.endsWith(".instagram.com")) return null;
  const m = /^\/(?:[^/]+\/)?(?:p|reels?|tv)\/([A-Za-z0-9_-]+)/.exec(u.pathname);
  return m ? m[1] : null;
}

/**
 * Shortcode → numeric media pk (what the API wants). Port of yt-dlp's
 * _id_to_pk: base-64 positional decode; shortcodes longer than 28 chars
 * (private-account link format) drop their last 28 chars first.
 * @returns {string} decimal pk
 */
export function shortcodeToPk(shortcode) {
  let sc = shortcode;
  if (sc.length > 28) sc = sc.slice(0, -28);
  let n = 0n;
  for (const ch of sc) {
    const v = ENCODING_CHARS.indexOf(ch);
    if (v === -1) throw new Error(`invalid shortcode character "${ch}"`);
    n = n * 64n + BigInt(v);
  }
  return n.toString();
}

/** Build a Cookie header from our normalized Netscape jar for one domain. */
async function cookieHeaderFor(cookiesFile, domainSuffix) {
  const text = await fs.readFile(cookiesFile, "utf8");
  const pairs = [];
  for (let line of text.split("\n")) {
    if (line.startsWith("#HttpOnly_")) line = line.slice("#HttpOnly_".length);
    if (!line || line.startsWith("#")) continue;
    const fields = line.split("\t");
    if (fields.length < 7) continue;
    const domain = fields[0].replace(/^\./, "");
    if (domain === domainSuffix || domain.endsWith(`.${domainSuffix}`)) {
      pairs.push(`${fields[5]}=${fields[6]}`);
    }
  }
  return pairs.join("; ");
}

/**
 * Fetch an Instagram post's photos via the logged-in web API.
 *
 * @param {string} url         Instagram post URL
 * @param {string} cookiesFile normalized Netscape jar (must hold a sessionid)
 * @param {{apiBase?: string, timeoutMs?: number}} [opts] test/timing overrides
 * @returns {Promise<{urls: string[], title?: string}>} photo URLs in post
 *   order (videos in mixed carousels are skipped); empty for a pure video post
 */
export async function fetchInstagramPhotosDirect(url, cookiesFile, opts = {}) {
  const shortcode = shortcodeFromUrl(url);
  if (!shortcode) throw new Error("not an Instagram post URL");
  if (!cookiesFile) {
    throw new Error("Instagram photos need login cookies (see README)");
  }
  const cookie = await cookieHeaderFor(cookiesFile, "instagram.com");
  if (!/(^|; )sessionid=/.test(cookie)) {
    throw new Error("cookies file has no Instagram sessionid cookie");
  }

  const pk = shortcodeToPk(shortcode);
  const res = await fetch(
    `${opts.apiBase ?? API_BASE}/media/${pk}/info/`,
    {
      headers: {
        "user-agent": BROWSER_UA,
        "x-ig-app-id": "936619743392459",
        "x-asbd-id": "359341",
        "x-ig-www-claim": "0",
        origin: "https://www.instagram.com",
        referer: "https://www.instagram.com/",
        accept: "*/*",
        cookie,
      },
      // A redirect to /accounts/login means the session is dead — surface
      // that instead of following into an HTML login page.
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    }
  );
  if (res.status >= 300 && res.status < 400) {
    throw new Error("Instagram session cookies appear to be expired (login redirect)");
  }
  if (!res.ok) {
    throw new Error(`Instagram API responded ${res.status}`);
  }
  const data = await res.json().catch(() => null);
  const item = data?.items?.[0];
  if (!item) throw new Error("Instagram API returned no media");

  // media_type: 1 = photo, 2 = video, 8 = carousel (with carousel_media).
  const media = Array.isArray(item.carousel_media) && item.carousel_media.length
    ? item.carousel_media
    : [item];
  const urls = [];
  for (const m of media) {
    const best = m?.image_versions2?.candidates?.[0]?.url;
    if (m?.media_type === 1 && best) urls.push(best);
  }
  return { urls, title: item.caption?.text || undefined };
}
