'use strict';

/**
 * api/handler.js — Vercel serverless entry point for the Gatekeeper agent.
 *
 * vercel.json rewrites / , /health and /task to this function. Vercel
 * passes the REWRITTEN path as req.url ('/api/handler'), so the original
 * route is recovered from the HTTP method: POST -> /task, GET -> /health.
 * (GET / therefore returns the health payload, not the service-info
 * payload — same data that matters for the platform health check.)
 *
 * All real logic lives in ../handler.js (shared with server.js), so the
 * Vercel deployment behaves identically to the local/Render server:
 * HMAC on the raw body, fail-closed decisions, signed responses.
 *
 * Vercel notes:
 *   - Zero dependencies; Node runtime (engines >= 18 in package.json).
 *   - SEEN_FILE must be /tmp/seen.json in the Vercel env vars: /tmp is
 *     the only writable path, and it lives only per function instance
 *     (warm). A cold instance starts with an empty seen-set — same
 *     limitation class as Render Free; do not redeploy mid-round.
 *   - Hobby functions answer in milliseconds; the 60 s platform deadline
 *     is comfortably met. Default Hobby timeout (10 s) is not a factor.
 */
const { createHandler, MAX_BODY_BYTES } = require('../handler');

const handler = createHandler();

function readRawBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { tooLarge = true; return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(tooLarge ? null : Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

module.exports = async (req, res) => {
  try {
    const rawBody = await readRawBody(req);
    if (rawBody === null) {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'body_too_large' }));
      return;
    }
    // Rewritten path: recover the logical route from the method.
    const urlPath = req.method === 'POST' ? '/task' : '/health';
    const result = await handler.handle(req.method, urlPath, req.headers || {}, rawBody);
    const body = JSON.stringify(result.body);
    res.writeHead(result.status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      ...(result.headers || {}),
    });
    res.end(body);
  } catch (err) {
    console.error(`[vercel] ${err.stack || err.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error' }));
    }
  }
};
