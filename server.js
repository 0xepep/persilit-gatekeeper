'use strict';

/**
 * server.js — Proof Gatekeeper agent endpoint (v1, decision-only).
 *
 * Zero dependencies: only Node.js built-ins (node:http, node:crypto...).
 * Thin http wrapper around handler.js, which holds all request logic and
 * is shared with the Vercel serverless entry (api/handler.js) — both
 * transports behave identically.
 *
 *   GET  /health  -> status, uptime, seen count, proof/hmac config
 *   GET  /        -> service info
 *   POST /task    -> verify HMAC on the RAW body first, then parse,
 *                    decide, sign the response, reply within 60 s.
 *
 * Env:
 *   PORT (default 3000), HOST (default 0.0.0.0)
 *   AGENT_GAMES_HMAC_SECRET — platform value from Rotate Secret. REQUIRED
 *     for signed traffic. No default, never hardcode a placeholder.
 *   ALLOW_UNSIGNED_TASKS=true — local dev only. Lets POST /task through
 *     without a signature (logs a warning per request). NEVER on the
 *     registered public endpoint.
 *   SEEN_FILE (default ./data/seen.json) — proof_tx persistence.
 *   PROOF_ENABLED — see proof.js; v1 always answers decision-only.
 *
 * Fail-closed: bad/missing signature -> 401, no decision. Unparseable
 * JSON -> 400, no decision. Unknown task type -> 400. Any decision
 * doubt -> REJECT (see decision.js). The decision itself is synchronous
 * (<1 ms typically), so the 60 s platform deadline is comfortably met;
 * if a request is already past its deadline_at we still answer REJECT
 * immediately rather than timing out silently.
 */
const http = require('node:http');
const { createHandler, TASK_TYPE, MAX_BODY_BYTES } = require('./handler');
const proof = require('./proof');

function createServer(opts = {}) {
  const handler = createHandler(opts);
  const { seen } = handler;

  const server = http.createServer((req, res) => {
    try {
      const urlPath = (req.url || '/').split('?')[0];
      if (req.method === 'GET') {
        // No body to read for GET.
        handler.handle(req.method, urlPath, req.headers, Buffer.alloc(0))
          .then((result) => {
            const body = JSON.stringify(result.body);
            res.writeHead(result.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(result.headers || {}) });
            res.end(body);
          })
          .catch((err) => {
            console.error(`[server] ${err.stack || err.message}`);
            if (!res.headersSent) {
              res.writeHead(500, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'internal_error' }));
            }
          });
        return;
      }

      // Read the RAW body (needed for HMAC) with a size cap.
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { tooLarge = true; return; }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (tooLarge) {
          res.writeHead(413, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'body_too_large' }));
          return;
        }
        handler.handle(req.method, urlPath, req.headers, Buffer.concat(chunks))
          .then((result) => {
            const body = JSON.stringify(result.body);
            res.writeHead(result.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(result.headers || {}) });
            res.end(body);
          })
          .catch((err) => {
            console.error(`[server] ${err.stack || err.message}`);
            if (!res.headersSent) {
              res.writeHead(500, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'internal_error' }));
            }
          });
      });
      req.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad_request' }));
        }
      });
    } catch (err) {
      console.error(`[server] ${err.stack || err.message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_error' }));
      }
    }
  });

  return { server, seen };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  const { server, seen } = createServer();
  server.listen(port, host, () => {
    console.log(`[gatekeeper] listening on http://${host}:${port} (use HTTPS in front — see README)`);
    console.log(`[gatekeeper] hmac_configured=${Boolean(process.env.AGENT_GAMES_HMAC_SECRET)} allow_unsigned=${process.env.ALLOW_UNSIGNED_TASKS === 'true'} proof_status=${proof.PROOF_STATUS} seen_count=${seen.size}`);
    if (!process.env.AGENT_GAMES_HMAC_SECRET) {
      console.log('[gatekeeper] WARNING: AGENT_GAMES_HMAC_SECRET not set — POST /task will 401 unless ALLOW_UNSIGNED_TASKS=true (local dev only).');
    }
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createServer, TASK_TYPE };
