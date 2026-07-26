// src/cookies.js
//
// Cookie-file tolerance. yt-dlp and gallery-dl both demand a strict
// Netscape-format cookies.txt, but real-world exports rarely arrive that
// clean: browser extensions export JSON, terminal pastes turn tabs into
// spaces, Windows adds \r\n, and people sometimes paste a raw "k=v; k2=v2"
// Cookie header. All of those are mechanically convertible — so instead of
// failing with "does not look like a Netscape format cookies file", the bot
// normalizes whatever it finds into a clean jar and uses that.

import fs from "node:fs/promises";
import path from "node:path";

const NETSCAPE_HEADER = "# Netscape HTTP Cookie File";

/**
 * Read a cookies file in any common format and produce a strict Netscape
 * jar the tools will accept. The original file is never modified.
 *
 * @param {string} srcPath  user-provided cookies file
 * @param {string} outDir   writable directory for the normalized copy
 * @returns {Promise<{path: string, note: string}>} path to use with
 *   --cookies, plus a human-readable note of what was detected
 * @throws {Error} when nothing cookie-like could be extracted
 */
export async function prepareCookiesFile(srcPath, outDir) {
  let raw = await fs.readFile(srcPath, "utf8");
  // BOM + Windows/old-Mac line endings are the most common paste damage.
  raw = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");

  let cookies;
  let note;
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    cookies = fromJsonExport(trimmed);
    note = `JSON export converted (${cookies.length} cookies)`;
  } else if (looksLikeHeaderString(trimmed)) {
    cookies = fromHeaderString(trimmed);
    note = `raw Cookie header converted for instagram.com (${cookies.length} cookies)`;
  } else {
    cookies = fromNetscapeish(raw);
    note = `Netscape file cleaned (${cookies.length} cookies)`;
  }

  if (!cookies.length) {
    throw new Error(
      "no cookies could be parsed from the file — export it again with a cookies.txt browser extension"
    );
  }

  const outPath = path.join(outDir, "cookies.normalized.txt");
  const lines = cookies.map(
    (c) =>
      `${c.httpOnly ? "#HttpOnly_" : ""}${c.domain}\t${c.includeSub ? "TRUE" : "FALSE"}\t${c.path}\t${c.secure ? "TRUE" : "FALSE"}\t${c.expires}\t${c.name}\t${c.value}`
  );
  await fs.writeFile(outPath, `${NETSCAPE_HEADER}\n${lines.join("\n")}\n`, {
    mode: 0o600,
  });
  return { path: outPath, note };
}

// A year from "now-ish" for session cookies without an expiry. Not Date.now()
// per cookie so the jar is stable within one run.
function farFuture() {
  return Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
}

/**
 * Cookie-Editor / EditThisCookie / "Export as JSON" shapes: an array of
 * cookie objects, sometimes wrapped in {cookies: [...]}.
 */
function fromJsonExport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("file starts like JSON but does not parse as JSON");
  }
  if (data && !Array.isArray(data) && Array.isArray(data.cookies)) {
    data = data.cookies;
  }
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const c of data) {
    if (!c || typeof c !== "object" || !c.name) continue;
    const domain = String(c.domain || c.host || "").trim();
    if (!domain) continue;
    out.push({
      domain,
      includeSub: domain.startsWith(".") || c.hostOnly === false,
      path: String(c.path || "/"),
      secure: Boolean(c.secure),
      expires: Math.floor(Number(c.expirationDate ?? c.expires ?? 0)) || farFuture(),
      name: String(c.name),
      value: String(c.value ?? ""),
      httpOnly: Boolean(c.httpOnly),
    });
  }
  return out;
}

// One line of "name=value; name2=value2" (a copied Cookie request header).
function looksLikeHeaderString(text) {
  return (
    !text.includes("\n") && !text.includes("\t") && /=\S/.test(text) && text.includes(";")
  );
}

/**
 * A pasted Cookie header has no domain info. The only login-walled site this
 * bot needs cookies for is Instagram, so that's the assumption — the startup
 * log states it.
 */
function fromHeaderString(text) {
  const out = [];
  for (const pair of text.split(";")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    out.push({
      domain: ".instagram.com",
      includeSub: true,
      path: "/",
      secure: true,
      expires: farFuture(),
      name,
      value,
    });
  }
  return out;
}

/**
 * Netscape-format lines, tolerating what pastes do to them: tabs collapsed
 * into spaces, stray blank/comment lines, #HttpOnly_ prefixes. Cookie names
 * and values can't contain whitespace, so splitting on runs of whitespace is
 * safe; a value with an embedded space (rare, quoted) survives via rejoin.
 */
function fromNetscapeish(text) {
  const out = [];
  for (let line of text.split("\n")) {
    line = line.trim();
    if (!line) continue;
    let httpOnly = false;
    if (line.startsWith("#HttpOnly_")) {
      httpOnly = true;
      line = line.slice("#HttpOnly_".length);
    } else if (line.startsWith("#")) {
      continue; // real comment
    }
    const fields = line.split(/[ \t]+/);
    if (fields.length < 6) continue;
    const [domain, flag, cookiePath, secure, expires, name, ...valueParts] = fields;
    // Sanity: field 2 and 4 are TRUE/FALSE in every real Netscape line.
    if (!/^(TRUE|FALSE)$/i.test(flag) || !/^(TRUE|FALSE)$/i.test(secure)) continue;
    out.push({
      domain,
      includeSub: /^TRUE$/i.test(flag) || domain.startsWith("."),
      path: cookiePath || "/",
      secure: /^TRUE$/i.test(secure),
      expires: Math.floor(Number(expires)) || farFuture(),
      name: name ?? "",
      value: valueParts.join(" "),
      httpOnly,
    });
  }
  return out.filter((c) => c.name);
}
