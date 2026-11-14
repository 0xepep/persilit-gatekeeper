'use strict';

/**
 * server.js — Proof Gatekeeper agent endpoint (v1, decision-only).
 *
 * Zero dependencies: only Node.js built-ins (node:http, node:crypto...).
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
const path = require('node:path');
const { decide, buildResponse } = require('./decision');
const { HEADER_NAME, signHeader, verifySignature } = require('./hmac');
const { SeenSet } = require('./seen');
const proof = require('./proof');

const TASK_TYPE = 'agent-games.proof-gatekeeper.v1';
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB — tasks are a few KB
const RESPONSE_DEADLINE_MS = 55_000; // answer well inside the 60 s limit

function json(res, status, obj, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': body.length,
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function createServer(opts = {}) {
  const secret = opts.secret ?? process.env.AGENT_GAMES_HMAC_SECRET ?? '';
  const allowUnsigned = opts.allowUnsigned ?? process.env.ALLOW_UNSIGNED_TASKS === 'true';
  const seenFile = opts.seenFile ?? process.env.SEEN_FILE ?? path.join(__dirname, 'data', 'seen.json');
  const seen = new SeenSet(seenFile);
  const startedAt = Date.now();

  const server = http.createServer((req, res) => {
    const started = Date.now();
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return json(res, 200, {
          status: 'ok',
          service: 'zkverify-gatekeeper-decision-v1',
          uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
          seen_count: seen.size,
          proof_enabled: proof.isProofEnabled(),
          proof_status: proof.PROOF_STATUS,
          hmac_configured: Boolean(secret),
          timestamp: new Date().toISOString(),
        });
      }
      if (req.method === 'GET' && req.url === '/') {
        return json(res, 200, {
          service: 'zkverify-gatekeeper-decision-v1',
          task_endpoint: 'POST /task',
          health_endpoint: 'GET /health',
          proof_status: proof.PROOF_STATUS,
        });
      }
      if (req.method !== 'POST' || req.url !== '/task') {
        return json(res, 404, { error: 'not_found' });
      }

      // --- Read the RAW body (needed for HMAC) with a size cap. ---
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { tooLarge = true; return; }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (tooLarge) return json(res, 413, { error: 'body_too_large' });
        const rawBody = Buffer.concat(chunks);

        // --- 1. Verify HMAC against the raw body BEFORE parsing. ---
        if (secret) {
          if (!verifySignature(secret, rawBody, req.headers[HEADER_NAME])) {
            console.warn(`[task] 401 invalid/missing ${HEADER_NAME}`);
            return json(res, 401, { error: 'invalid_signature' });
          }
        } else if (!allowUnsigned) {
          console.warn('[task] 401 HMAC secret not configured and ALLOW_UNSIGNED_TASKS is not true');
          return json(res, 401, { error: 'hmac_not_configured' });
        } else {
          console.warn('[task] WARNING: accepting unsigned task (ALLOW_UNSIGNED_TASKS=true, local dev only)');
        }

        // --- 2. Parse only after the signature checks out. ---
        let task;
        try {
          task = JSON.parse(rawBody.toString('utf8'));
        } catch {
          return json(res, 400, { error: 'invalid_json' });
        }
        if (!task || typeof task !== 'object' || (task.type && task.type !== TASK_TYPE)) {
          return json(res, 400, { error: 'invalid_task_type', expected: TASK_TYPE });
        }

        // --- 3. Fail closed if we are already past the task deadline. ---
        const deadlineMs = task.deadline_at ? Date.parse(task.deadline_at) : NaN;
        if (!Number.isNaN(deadlineMs) && Date.now() > deadlineMs) {
          const early = buildResponse({
            decision: 'REJECT',
            reason_code: 'EXPIRED_CONDITION',
            proof_tx: (task.input && task.input.proof_tx) || '',
          });
          const body = JSON.stringify(early);
          console.warn(`[task] ${task.task_id || '?'} past deadline_at — REJECT EXPIRED_CONDITION`);
          return json(res, 200, early, secret ? { [HEADER_NAME]: signHeader(secret, body) } : undefined);
        }

        // --- 4. Decide (pure, synchronous). Proof is v1 stub: decision-only. ---
        if (proof.isProofEnabled()) {
          // v1: generateGatekeeperProof() throws; log once per task, do not crash.
          proof.generateGatekeeperProof(task, null).catch((err) => {
            console.warn(`[proof] ${err.message}`);
          });
        }
        const result = decide(task, seen);
        const response = buildResponse(result);
        const body = JSON.stringify(response);
        const headers = secret ? { [HEADER_NAME]: signHeader(secret, body) } : undefined;

        if (Date.now() - started > RESPONSE_DEADLINE_MS) {
          console.warn(`[task] ${task.task_id || '?'} slow response (${Date.now() - started} ms)`);
        }
        console.log(`[task] ${task.task_id || '?'} mode=${task.mode || '?'} -> ${result.decision} ${result.reason_code} (${Date.now() - started} ms)`);
        return json(res, 200, response, headers);
      });
      req.on('error', () => json(res, 400, { error: 'bad_request' }));
    } catch (err) {
      console.error(`[server] ${err.stack || err.message}`);
      if (!res.headersSent) return json(res, 500, { error: 'internal_error' });
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
