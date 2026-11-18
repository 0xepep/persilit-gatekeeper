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
const { decide, buildResponse, REASON_CODES } = require('./decision');
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
    // A SIGNED POST that is not a valid task envelope is the platform's
    // signed preflight / health probe (empty body, non-JSON, or a probe
    // type). The dashboard save runs this probe and refuses to persist
    // the endpoint unless it answers 200, so answer 200 with the
    // standard fail-closed decision envelope (signed) — a real task
    // always carries the task type and reaches decide() below.
    // A probe can never approve anything: decide({}) fails closed.
    let task = null;
    let isProbe = false;
    const rawText = body.toString('utf8');
    if (rawText.trim() === '') {
      isProbe = true;
    } else {
      try {
        task = JSON.parse(rawText);
      } catch {
        isProbe = true;
      }
      if (!isProbe && (!task || typeof task !== 'object' || Array.isArray(task) || (task.type && task.type !== TASK_TYPE))) {
        isProbe = true;
      }
    }
    if (isProbe) {
      // The platform's preflight probe (type agent-games.preflight.v1,
      // confirmed from the live Vercel log 2026-11-15) expects the
      // starter-prompt response: { ok: true, protocolVersion: "v1" },
      // SIGNED. A decision envelope for the probe fails the platform's
      // preflight validation ("must return signed protocol-v1 JSON").
      if (task && task.type === 'agent-games.preflight.v1') {
        const pre = { ok: true, protocolVersion: 'v1' };
        console.log('[task] signed preflight probe -> 200 { ok: true, protocolVersion: "v1" }');
        return ok(pre, secret ? { [HEADER_NAME]: signHeader(secret, JSON.stringify(pre)) } : undefined);
      }
      console.log(`[task] signed preflight probe (${rawText.slice(0, 120) || '<empty>'}) -> 200 REJECT VK_SUBSTITUTION`);
      const probe = buildResponse(decide({}, seen));
      return ok(probe, secret ? { [HEADER_NAME]: signHeader(secret, JSON.stringify(probe)) } : undefined);
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

    // --- 4. Decide (pure, synchronous), then prove the decision. ---
    // Proof is attempted only when PROOF_ENABLED=true and the task is
    // provable: PROOF_REUSED carries no proof (scoring excludes it, and
    // the circuit cannot prove rejecting an otherwise-valid condition).
    // Any proof failure falls back to the decision-only response —
    // same -2 as v1, never worse — and never blocks the deadline: the
    // proof budget is capped at 45 s and at (deadline_at - 5 s).
    const result = decide(task, seen);
    const response = buildResponse(result);
    let proofMs = null;
    if (proof.isProofEnabled() && result.reason_code !== REASON_CODES.PROOF_REUSED) {
      let budget = proof.PROOF_TIMEOUT_MS;
      if (!Number.isNaN(deadlineMs)) {
        budget = Math.min(budget, Math.max(0, deadlineMs - Date.now() - 5000));
      }
      if (budget > 0) {
        try {
          const generated = await proof.generateGatekeeperProof(task, result.decision, { timeoutMs: budget });
          response.proof = generated.proof;
          response.public_signals = generated.publicSignals;
          proofMs = generated.proofMs;
        } catch (e) {
          console.warn(`[proof] ${task.task_id || '?'} ${e.message} — answering decision-only`);
        }
      } else {
        console.warn(`[proof] ${task.task_id || '?'} no time left before deadline_at — answering decision-only`);
      }
    }
    const signed = secret ? { [HEADER_NAME]: signHeader(secret, JSON.stringify(response)) } : undefined;

    if (Date.now() - started > RESPONSE_DEADLINE_MS) {
      console.warn(`[task] ${task.task_id || '?'} slow response (${Date.now() - started} ms)`);
    }
    console.log(`[task] ${task.task_id || '?'} mode=${task.mode || '?'} -> ${result.decision} ${result.reason_code}${proofMs === null ? ' (no proof)' : ` proof ${proofMs}ms`} (${Date.now() - started} ms)`);
    return ok(response, signed);
  }

  return { handle, seen };
}

module.exports = { createHandler, TASK_TYPE, MAX_BODY_BYTES };
