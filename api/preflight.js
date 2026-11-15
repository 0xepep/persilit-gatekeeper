'use strict';

/**
 * api/preflight.js — standalone GET /preflight handler (Vercel rewrite
 * /preflight -> /api/preflight in vercel.json).
 *
 * The Agent Games starter prompt specifies: "A /preflight handler that
 * returns { ok: true, protocolVersion: 'v1' } as a signed response."
 * The platform's signed preflight probe is a POST to the registered
 * endpoint root (handled in ../handler.js); this GET route is the same
 * payload for any direct preflight health check. Signed with the
 * platform HMAC secret (bare hex, as the platform itself signs).
 */
const { HEADER_NAME, signHeader } = require('../hmac');

module.exports = async (req, res) => {
  try {
    const secret = process.env.AGENT_GAMES_HMAC_SECRET || '';
    const body = { ok: true, protocolVersion: 'v1' };
    const raw = JSON.stringify(body);
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(raw),
      ...(secret ? { [HEADER_NAME]: signHeader(secret, raw) } : {}),
    });
    res.end(raw);
  } catch (err) {
    console.error(`[preflight] ${err.stack || err.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error' }));
    }
  }
};
