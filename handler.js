'use strict';

/**
 * handler.js — transport-agnostic request core, shared by:
 *   - server.js       (long-running Node http server, e.g. Render / local)
 *   - api/handler.js  (Vercel serverless function)
 *
 * Same rules in both transports: HMAC verified on the RAW body BEFORE
 * parsing, fail-closed decisions, signed responses, 60 s deadline guard.
 *
 * handle(method, urlPath, headers, rawBody) ->
 *   { status, body (object), headers } — callers only stringify + send.
 */
const path = require('node:path');
const { decide, buildResponse } = require('./decision');
const { HEADER_NAME, signHeader, verifySignature } = require('./hmac');
const { SeenSet } = require('./seen');
const proof = require('./proof');

const TASK_TYPE = 'agent-games.proof-gatekeeper.v1';
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB — tasks are a few KB
const RESPONSE_DEADLINE_MS = 55_000; // answer well inside the 60 s limit

function createHandler(opts = {}) {
  const secret = opts.secret ?? process.env.AGENT_GAMES_HMAC_SECRET ?? '';
  const allowUnsigned = opts.allowUnsigned ?? process.env.ALLOW_UNSIGNED_TASKS === 'true';
  const seenFile = opts.seenFile ?? process.env.SEEN_FILE ?? path.join(__dirname, 'data', 'seen.json');
  const seen = new SeenSet(seenFile);
  const startedAt = Date.now();

  const ok = (body, extraHeaders) => ({ status: 200, body, headers: { ...(extraHeaders || {}) } });
  const err = (status, body) => ({ status, body, headers: {} });

  async function handle(method, urlPath, headers, rawBody) {
    const started = Date.now();
    const pathOnly = (urlPath || '/').split('?')[0];
    const hdrs = headers || {};

    if (method === 'GET' && pathOnly === '/health') {
      return ok({
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
    if (method === 'GET' && pathOnly === '/') {
      return ok({
        service: 'zkverify-gatekeeper-decision-v1',
        task_endpoint: 'POST /task',
        health_endpoint: 'GET /health',
        proof_status: proof.PROOF_STATUS,
      });
    }
    if (method !== 'POST' || pathOnly !== '/task') {
      return err(404, { error: 'not_found' });
    }

    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || '');
    if (body.length > MAX_BODY_BYTES) return err(413, { error: 'body_too_large' });

    // --- 1. Verify HMAC against the raw body BEFORE parsing. ---
    if (secret) {
      if (!verifySignature(secret, body, hdrs[HEADER_NAME])) {
        console.warn(`[task] 401 invalid/missing ${HEADER_NAME}`);
        return err(401, { error: 'invalid_signature' });
      }
    } else if (!allowUnsigned) {
      console.warn('[task] 401 HMAC secret not configured and ALLOW_UNSIGNED_TASKS is not true');
      return err(401, { error: 'hmac_not_configured' });
    } else {
      console.warn('[task] WARNING: accepting unsigned task (ALLOW_UNSIGNED_TASKS=true, local dev only)');
    }

    // --- 2. Parse only after the signature checks out. ---
    let task;
    try {
      task = JSON.parse(body.toString('utf8'));
    } catch {
      return err(400, { error: 'invalid_json' });
    }
    if (!task || typeof task !== 'object' || (task.type && task.type !== TASK_TYPE)) {
      return err(400, { error: 'invalid_task_type', expected: TASK_TYPE });
    }

    // --- 3. Fail closed if we are already past the task deadline. ---
    const deadlineMs = task.deadline_at ? Date.parse(task.deadline_at) : NaN;
    if (!Number.isNaN(deadlineMs) && Date.now() > deadlineMs) {
      const early = buildResponse({
        decision: 'REJECT',
        reason_code: 'EXPIRED_CONDITION',
        proof_tx: (task.input && task.input.proof_tx) || '',
      });
      console.warn(`[task] ${task.task_id || '?'} past deadline_at — REJECT EXPIRED_CONDITION`);
      return ok(early, secret ? { [HEADER_NAME]: signHeader(secret, JSON.stringify(early)) } : undefined);
    }

    // --- 4. Decide (pure, synchronous). Proof is v1 stub: decision-only. ---
    if (proof.isProofEnabled()) {
      // v1: generateGatekeeperProof() throws; log once per task, do not crash.
      proof.generateGatekeeperProof(task, null).catch((e) => {
        console.warn(`[proof] ${e.message}`);
      });
    }
    const result = decide(task, seen);
    const response = buildResponse(result);
    const signed = secret ? { [HEADER_NAME]: signHeader(secret, JSON.stringify(response)) } : undefined;

    if (Date.now() - started > RESPONSE_DEADLINE_MS) {
      console.warn(`[task] ${task.task_id || '?'} slow response (${Date.now() - started} ms)`);
    }
    console.log(`[task] ${task.task_id || '?'} mode=${task.mode || '?'} -> ${result.decision} ${result.reason_code} (${Date.now() - started} ms)`);
    return ok(response, signed);
  }

  return { handle, seen };
}

module.exports = { createHandler, TASK_TYPE, MAX_BODY_BYTES };
