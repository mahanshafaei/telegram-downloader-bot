// src/cache.js
//
// Optional file_id cache backed by Cloudflare KV.
//
// The first time we deliver a link, Telegram downloads the media from a URL we
// hand it and returns a file_id. We store that id keyed by the original link,
// so the next request for the same link is re-sent straight from Telegram's
// own storage: no re-download, no size limit, effectively instant.
//
// The whole thing is optional. If no KV namespace is bound to MEDIA_CACHE,
// every function here quietly no-ops and the bot works exactly as before.

const TTL_SECONDS = 60 * 60 * 24 * 30; // keep entries for 30 days

/**
 * Build a stable cache key from a link (plus an optional variant such as a
 * YouTube quality). Query strings and fragments are dropped so the same post
 * shared with different tracking params still hits.
 */
export function cacheKey(platform, urlOrId, variant = "") {
  const base = normalize(urlOrId);
  return variant ? `${platform}:${base}:${variant}` : `${platform}:${base}`;
}

function normalize(value) {
  try {
    const u = new URL(value);
    return (u.host.toLowerCase() + u.pathname).replace(/\/+$/, "");
  } catch {
    // Not a URL (e.g. a bare YouTube id) — use it verbatim, case intact.
    return String(value).trim();
  }
}

export async function getCached(env, key) {
  if (!env.MEDIA_CACHE) return null;
  const raw = await env.MEDIA_CACHE.get(key).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function putCached(env, key, value) {
  if (!env.MEDIA_CACHE || !value || !value.items || !value.items.length) return;
  await env.MEDIA_CACHE.put(key, JSON.stringify(value), {
    expirationTtl: TTL_SECONDS,
  }).catch(() => {});
}

export async function dropCached(env, key) {
  if (!env.MEDIA_CACHE) return;
  await env.MEDIA_CACHE.delete(key).catch(() => {});
}
