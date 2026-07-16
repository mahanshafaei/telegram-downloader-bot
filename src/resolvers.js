// src/resolvers.js
//
// Turns a platform URL into downloadable media items.
//
// A Cloudflare Worker runs on a datacenter IP, which the platforms block if we
// scrape them directly, so resolving goes through public services with
// fallbacks:
//
//   TikTok      tikwm.com (no key, watermark-free URLs)
//   YouTube     a cobalt instance (open-source downloader API)
//   Instagram   cobalt, then an og:meta fallback
//   Pinterest   og:meta, then cobalt as a fallback
//
// The cobalt instance URL and optional key come from env (COBALT_API_URL,
// COBALT_API_KEY), so you can self-host or swap instances without code changes.
//
// Each resolver returns:
//   { title, items: [ { type: "video"|"photo"|"audio", url, size? } ] }

import { fetchJson, fetchWithTimeout, DEFAULT_UA, extractUrl } from "./util.js";

/* ------------------------------------------------------------------ */
/* Platform detection                                                  */
/* ------------------------------------------------------------------ */

export const Platform = {
  YOUTUBE: "youtube",
  INSTAGRAM: "instagram",
  TIKTOK: "tiktok",
  PINTEREST: "pinterest",
};

/**
 * @param {string} url
 * @returns {string|null} one of Platform.*
 */
export function detectPlatform(url) {
  if (/(?:youtube\.com|youtu\.be|youtube-nocookie\.com)/i.test(url))
    return Platform.YOUTUBE;
  if (/instagram\.com/i.test(url)) return Platform.INSTAGRAM;
  if (/(?:tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)/i.test(url))
    return Platform.TIKTOK;
  if (/(?:pinterest\.[a-z.]+|pin\.it)/i.test(url)) return Platform.PINTEREST;
  return null;
}

/**
 * Extract an 11-char YouTube video id from any common URL shape.
 * @param {string} url
 * @returns {string|null}
 */
export function youtubeId(url) {
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /\/shorts\/([a-zA-Z0-9_-]{11})/,
    /\/embed\/([a-zA-Z0-9_-]{11})/,
    /\/live\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Cobalt: shared resolver for YouTube / Instagram / Pinterest         */
/* ------------------------------------------------------------------ */

// Fallback public cobalt instances used when COBALT_API_URL is not set. These
// work without an API key (the official api.cobalt.tools now requires auth).
// COBALT_API_URL overrides this with a single URL or a comma-separated list,
// tried in order. Self-hosting your own instance is best for heavy use.
const DEFAULT_COBALT_INSTANCES = [
  "https://co.otomir23.me",
  "https://dwnld.nichind.dev",
];

/**
 * Resolve a media URL through a cobalt instance.
 *
 * @param {object} env
 * @param {string} url media page url
 * @param {object} [opts] { quality: "720", audioOnly: bool }
 * @returns {Promise<{title?:string, items:Array}>}
 */
export async function cobaltResolve(env, url, opts = {}) {
  const instances = (env.COBALT_API_URL
    ? env.COBALT_API_URL.split(",")
    : DEFAULT_COBALT_INSTANCES
  )
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const quality = opts.quality ? String(opts.quality).replace(/p$/i, "") : "720";

  // Modern cobalt (v10/v11) STRICTLY validates the body and rejects any
  // unknown field with error.api.invalid_body — so send only current keys.
  const body = {
    url,
    videoQuality: quality,
    downloadMode: opts.audioOnly ? "audio" : "auto",
    filenameStyle: "basic",
  };

  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": DEFAULT_UA,
  };
  if (env.COBALT_API_KEY) headers.authorization = `Api-Key ${env.COBALT_API_KEY}`;

  // Modern cobalt exposes the API at the root path; the old /api/json route
  // only exists on legacy instances and 404s here, so we skip it. Instances
  // occasionally fail with content.no_valid_content, so make a few passes
  // over the list before giving up.
  const ATTEMPTS = 3;
  let lastErr;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    for (const endpoint of instances) {
      try {
        const { ok, status, data } = await fetchJson(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          timeoutMs: 20000,
        });
        const parsed = parseCobalt(data);
        if (parsed.items.length) return parsed;
        // Prefer a descriptive cobalt error over a bare HTTP failure.
        if (data && data.status === "error") lastErr = new Error(cobaltError(data));
        else if (!ok) lastErr = new Error(`HTTP ${status} from ${endpoint}`);
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw lastErr || new Error("Cobalt returned no downloadable media.");
}

function parseCobalt(data) {
  if (!data || typeof data !== "object") return { items: [] };
  const title = data.filename || data.text || undefined;
  const status = data.status;

  // Single URL responses.
  if (
    (status === "tunnel" ||
      status === "redirect" ||
      status === "stream" ||
      status === "success") &&
    data.url
  ) {
    return {
      title,
      items: [{ type: guessType(data.url, title), url: data.url }],
    };
  }

  // Picker: multiple items (albums / multi-photo posts).
  if (status === "picker" && Array.isArray(data.picker)) {
    const items = data.picker
      .filter((p) => p && p.url)
      .map((p) => ({
        type: p.type === "video" ? "video" : "photo",
        url: p.url,
      }));
    if (data.audio) items.push({ type: "audio", url: data.audio });
    return { title, items };
  }

  // Some instances just return { url } with no status.
  if (data.url) {
    return { title, items: [{ type: guessType(data.url, title), url: data.url }] };
  }
  return { title, items: [] };
}

function cobaltError(data) {
  const code = data?.error?.code || data?.text || data?.error || "unknown error";
  // Translate the most common cobalt codes into something a user understands.
  const friendly = {
    "content.no_valid_content":
      "the downloader couldn't fetch this post right now (try again in a moment)",
    "fetch.empty":
      "Instagram is requiring a login to view this specific post, so it can't be fetched anonymously. Some public posts work; this one is login-walled.",
    "link.invalid": "that link isn't in a form the downloader recognizes",
    "content.too_long": "the media is too long/large to process",
  };
  return friendly[code] || `downloader error (${code})`;
}

function guessType(url, title = "") {
  const s = (url + " " + title).toLowerCase();
  if (/\.(mp4|mov|webm|m4v)(\?|$)/.test(s) || /video/.test(s)) return "video";
  if (/\.(mp3|m4a|opus|ogg|wav)(\?|$)/.test(s) || /audio/.test(s))
    return "audio";
  if (/\.(jpg|jpeg|png|webp|gif)(\?|$)/.test(s)) return "photo";
  return "video";
}

/* ------------------------------------------------------------------ */
/* TikTok (tikwm.com) — watermark-free                                 */
/* ------------------------------------------------------------------ */

export async function resolveTikTok(env, url) {
  const api = "https://www.tikwm.com/api/";
  const { data } = await fetchJson(
    `${api}?hd=1&url=${encodeURIComponent(url)}`,
    { timeoutMs: 20000 }
  );
  if (data.code !== 0 || !data.data) {
    // Fall back to cobalt if tikwm is down or rate-limited.
    return cobaltResolve(env, url);
  }
  const d = data.data;
  const items = [];
  // Prefer HD no-watermark, then SD no-watermark.
  const video = d.hdplay || d.play || d.wmplay;
  if (video) {
    items.push({
      type: "video",
      url: absolutize(video),
      size: d.hd_size || d.size,
    });
  } else if (Array.isArray(d.images)) {
    // Photo (slideshow) post.
    for (const img of d.images) items.push({ type: "photo", url: img });
  }
  return {
    title: d.title || "TikTok",
    items,
  };
}

// tikwm sometimes returns root-relative paths.
function absolutize(u) {
  if (u.startsWith("http")) return u;
  return `https://www.tikwm.com${u}`;
}

/* ------------------------------------------------------------------ */
/* Instagram (cobalt primary, og-meta fallback)                        */
/* ------------------------------------------------------------------ */

export async function resolveInstagram(env, url) {
  try {
    const r = await cobaltResolve(env, url);
    if (r.items.length) return r;
  } catch (e) {
    console.log(`Instagram cobalt failed: ${e.message}`);
  }
  return ogMetaResolve(url, "Instagram");
}

/* ------------------------------------------------------------------ */
/* Pinterest (og-meta primary, cobalt fallback)                        */
/* ------------------------------------------------------------------ */

export async function resolvePinterest(env, url) {
  // Resolve pin.it short links first.
  let target = url;
  if (/pin\.it/i.test(url)) {
    try {
      const res = await fetchWithTimeout(url, {
        redirect: "follow",
        timeoutMs: 15000,
        headers: { "user-agent": DEFAULT_UA },
      });
      target = res.url || url;
    } catch {
      /* keep original */
    }
  }
  try {
    const meta = await ogMetaResolve(target, "Pinterest");
    if (meta.items.length) return meta;
  } catch (e) {
    console.log(`Pinterest meta failed: ${e.message}`);
  }
  return cobaltResolve(env, target);
}

/* ------------------------------------------------------------------ */
/* Generic Open Graph meta parser (no third-party service)             */
/* ------------------------------------------------------------------ */

/**
 * Fetch a page and read og:video / og:image (and a few JSON-ish fallbacks).
 * Cheap, service-free, works for many public Pinterest/Instagram pages.
 */
export async function ogMetaResolve(url, label) {
  const res = await fetchWithTimeout(url, {
    timeoutMs: 15000,
    headers: {
      "user-agent": DEFAULT_UA,
      accept: "text/html,application/xhtml+xml",
    },
  });
  const html = await res.text();

  const video =
    metaContent(html, "og:video:secure_url") ||
    metaContent(html, "og:video:url") ||
    metaContent(html, "og:video") ||
    firstMatch(html, /"contentUrl":"([^"]+\.mp4[^"]*)"/);
  const image =
    metaContent(html, "og:image:secure_url") ||
    metaContent(html, "og:image") ||
    firstMatch(html, /"display_url":"([^"]+)"/);
  const title =
    metaContent(html, "og:title") || label || "media";

  const items = [];
  if (video) items.push({ type: "video", url: decodeEntities(video) });
  else if (image) items.push({ type: "photo", url: decodeEntities(image) });

  if (!items.length) {
    throw new Error(`No og:media found on ${label} page.`);
  }
  return { title, items };
}

function metaContent(html, prop) {
  // property="og:x" content="..."  OR  content="..." property="og:x"
  const re1 = new RegExp(
    `<meta[^>]+(?:property|name)=["']${escapeRe(prop)}["'][^>]+content=["']([^"']+)["']`,
    "i"
  );
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escapeRe(prop)}["']`,
    "i"
  );
  return firstMatch(html, re1) || firstMatch(html, re2);
}

function firstMatch(s, re) {
  const m = s.match(re);
  return m ? m[1] : null;
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function decodeEntities(s) {
  return s
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
}

/* ------------------------------------------------------------------ */
/* Top-level dispatch                                                  */
/* ------------------------------------------------------------------ */

/**
 * Resolve any supported URL (non-YouTube; YouTube has its own quality flow).
 * @param {object} env
 * @param {string} platform
 * @param {string} url
 */
export async function resolve(env, platform, url) {
  switch (platform) {
    case Platform.TIKTOK:
      return resolveTikTok(env, url);
    case Platform.INSTAGRAM:
      return resolveInstagram(env, url);
    case Platform.PINTEREST:
      return resolvePinterest(env, url);
    case Platform.YOUTUBE:
      return cobaltResolve(env, url); // used only if a quality is preselected
    default:
      throw new Error("Unsupported platform.");
  }
}

export { extractUrl };
