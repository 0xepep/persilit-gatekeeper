'use strict';

/**
 * hmac.js — HMAC-SHA256 signing / verification for Agent Games.
 *
 * Per https://agentgames.zkverify.io/build §04:
 *  - Verify the HMAC signature against the RAW request body BEFORE
 *    parsing or processing the task.
 *  - Every response is signed with header `x-agent-games-signature`
 *    over the RAW response body.
 *  - "The HMAC secret matches the platform-generated value from
 *    Rotate Secret — never a local placeholder."
 *
 * So: the secret comes ONLY from env AGENT_GAMES_HMAC_SECRET (set from
 * the platform dashboard's Rotate Secret). There is no default secret
 * in this codebase. server.js refuses signed traffic when no secret is
 * configured, unless ALLOW_UNSIGNED_TASKS=true is set explicitly for
 * local dev — never set that in production / on the registered endpoint.
 *
 * Header format assumed: `sha256=<hex>` (the common GitHub-style form).
 * A bare hex digest is also accepted. This is an ASSUMPTION to confirm
 * in Practice Mode — if the platform uses a different header name or
 * format, adjust here only, and re-run the tests.
 */
const crypto = require('node:crypto');

const HEADER_NAME = 'x-agent-games-signature';

/** "sha256=ab12..." -> "ab12..."; bare hex passes through. Returns '' if not hex. */
function normalizeSignature(value) {
  if (typeof value !== 'string') return '';
  let hex = value.trim();
  if (hex.toLowerCase().startsWith('sha256=')) hex = hex.slice('sha256='.length);
  hex = hex.trim().toLowerCase();
  return /^[0-9a-f]+$/.test(hex) && hex.length % 2 === 0 ? hex : '';
}

/** HMAC-SHA256 hex digest of the raw body under `secret`. */
function hmacHex(secret, rawBody) {
  if (!secret) throw new Error('hmacHex: no secret configured (AGENT_GAMES_HMAC_SECRET).');
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/** Full header value to send: `sha256=<hex>`. */
function signHeader(secret, rawBody) {
  return `sha256=${hmacHex(secret, rawBody)}`;
}

/**
 * Timing-safe verification. Returns false (never throws) for a missing /
 * malformed signature or secret — callers treat false as "reject the task".
 */
function verifySignature(secret, rawBody, signatureHeader) {
  try {
    if (!secret || typeof signatureHeader !== 'string') return false;
    const provided = normalizeSignature(signatureHeader);
    if (!provided) return false;
    const expected = hmacHex(secret, rawBody);
    const a = Buffer.from(provided, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

module.exports = { HEADER_NAME, hmacHex, signHeader, verifySignature, normalizeSignature };
