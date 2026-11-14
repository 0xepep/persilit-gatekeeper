'use strict';

/**
 * decision.js — pure decision logic for Proof Gatekeeper (v1, decision-only).
 *
 * No I/O, no network, no secrets here — so it is trivially unit-testable.
 * Order of checks is the order in the task spec (and the trap encyclopedia
 * on https://agentgames.zkverify.io/events/proof-gatekeeper):
 *
 *   1. proof_tx already in seen-set        -> PROOF_REUSED      REJECT
 *   2. proof_vk != registered_vk           -> VK_SUBSTITUTION   REJECT
 *   3. public_balance < minimum            -> THRESHOLD_MISMATCH REJECT
 *   4. current_block > expiry_block        -> EXPIRED_CONDITION REJECT
 *   5. recipient != condition_recipient    -> RECIPIENT_MISMATCH REJECT
 *   6. amount > max_transfer               -> AMOUNT_OVERFLOW   REJECT
 *   7. everything passes                   -> VALID_CONDITION  APPROVE
 *
 * Fail-closed: any missing / unparseable field is treated as a failed
 * check at the step that needs it (never as a pass). A REJECT caused by a
 * malformed field uses the reason_code of that step — see README.md.
 *
 * Scoring (from the event page): correct +12, wrong APPROVE -6,
 * wrong REJECT -3, timeout -2. A correct decision without a valid
 * Groth16 proof costs an extra -2 and earns no reliability bonus
 * (+0..+5) — that is the known v1 limitation, see proof.js.
 *
 * Seen-set nuance: the event page describes PROOF_REUSED as a proof
 * "already accepted in a previous task". This implementation marks EVERY
 * processed proof_tx as seen (even rejected ones) — deliberately
 * stricter / fail-closed: a proof the platform sends twice is a reuse
 * trap until proven otherwise. Verify this against Practice Mode before
 * the first scored round; if practice shows rejected proofs are
 * legitimately re-sent, narrow the rule to APPROVE-only.
 */

const REASON_CODES = Object.freeze({
  VALID_CONDITION: 'VALID_CONDITION',
  VK_SUBSTITUTION: 'VK_SUBSTITUTION',
  THRESHOLD_MISMATCH: 'THRESHOLD_MISMATCH',
  PROOF_REUSED: 'PROOF_REUSED',
  EXPIRED_CONDITION: 'EXPIRED_CONDITION',
  RECIPIENT_MISMATCH: 'RECIPIENT_MISMATCH',
  AMOUNT_OVERFLOW: 'AMOUNT_OVERFLOW',
});

/**
 * Parse an integer that may arrive as a JSON number, a numeric string
 * ("1460"), or a large value. Returns a BigInt, or null if unparseable.
 */
function toBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value)) return null;
    return BigInt(value);
  }
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) {
    try { return BigInt(value.trim()); } catch { return null; }
  }
  return null;
}

/** Compare two integer-ish values: -1 / 0 / 1, or null if either is unparseable. */
function compareBigInt(a, b) {
  const x = toBigInt(a);
  const y = toBigInt(b);
  if (x === null || y === null) return null;
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
}

function normalizeAddress(addr) {
  return typeof addr === 'string' ? addr.trim().toLowerCase() : '';
}

function normalizeTx(tx) {
  return typeof tx === 'string' ? tx.trim().toLowerCase() : '';
}

function reject(reasonCode, proofTx, detail) {
  return { decision: 'REJECT', reason_code: reasonCode, proof_tx: proofTx || '', detail };
}

function approve(proofTx) {
  return { decision: 'APPROVE', reason_code: REASON_CODES.VALID_CONDITION, proof_tx: proofTx || '', detail: 'All checks passed.' };
}

/**
 * Decide on one task.
 * @param {object} task - parsed task envelope (task.input holds the fields)
 * @param {object} seen - seen-set with has(tx)/add(tx); a Set works too
 * @returns {{decision:'APPROVE'|'REJECT', reason_code:string, proof_tx:string, detail:string}}
 */
function decide(task, seen) {
  const input = task && typeof task === 'object' ? task.input : null;
  if (!input || typeof input !== 'object') {
    return reject(REASON_CODES.VK_SUBSTITUTION, '', 'Missing or invalid task.input — fail closed.');
  }

  const proofTx = typeof input.proof_tx === 'string' ? input.proof_tx : '';
  const seenKey = normalizeTx(proofTx);

  // (1) Proof reuse — check BEFORE any other check, and before recording.
  if (seenKey && seen && typeof seen.has === 'function' && seen.has(seenKey)) {
    return reject(REASON_CODES.PROOF_REUSED, proofTx, 'proof_tx was already processed in an earlier task.');
  }

  // Record the proof as seen for every decision we actually process.
  // (A PROOF_REUSED outcome above returns early and is NOT re-recorded.)
  let result;
  const registeredVk = typeof input.registered_vk === 'string' ? input.registered_vk.trim().toLowerCase() : '';
  const proofVk = typeof input.proof_vk === 'string' ? input.proof_vk.trim().toLowerCase() : '';

  // (2) Verification-key substitution (also covers a missing VK).
  if (!registeredVk || !proofVk || proofVk !== registeredVk) {
    result = reject(REASON_CODES.VK_SUBSTITUTION, proofTx, 'proof_vk does not match registered_vk (or VK missing).');
  } else if (compareBigInt(input.public_balance, input.minimum) === null) {
    // (3a) Threshold fields unparseable — fail closed as threshold failure.
    result = reject(REASON_CODES.THRESHOLD_MISMATCH, proofTx, 'public_balance/minimum missing or unparseable.');
  } else if (compareBigInt(input.public_balance, input.minimum) < 0) {
    // (3) Threshold mismatch.
    result = reject(REASON_CODES.THRESHOLD_MISMATCH, proofTx, 'public_balance is below the required minimum.');
  } else if (compareBigInt(input.current_block, input.expiry_block) === null) {
    // (4a) Block fields unparseable — fail closed as expired.
    result = reject(REASON_CODES.EXPIRED_CONDITION, proofTx, 'current_block/expiry_block missing or unparseable.');
  } else if (compareBigInt(input.current_block, input.expiry_block) > 0) {
    // (4) Expired condition.
    result = reject(REASON_CODES.EXPIRED_CONDITION, proofTx, 'current_block is past expiry_block.');
  } else if (!normalizeAddress(input.recipient) || normalizeAddress(input.recipient) !== normalizeAddress(input.condition_recipient)) {
    // (5) Recipient mismatch (also covers a missing recipient).
    result = reject(REASON_CODES.RECIPIENT_MISMATCH, proofTx, 'recipient does not match condition_recipient.');
  } else if (compareBigInt(input.amount, input.max_transfer) === null) {
    // (6a) Amount fields unparseable — fail closed as overflow.
    result = reject(REASON_CODES.AMOUNT_OVERFLOW, proofTx, 'amount/max_transfer missing or unparseable.');
  } else if (compareBigInt(input.amount, input.max_transfer) > 0) {
    // (6) Amount overflow.
    result = reject(REASON_CODES.AMOUNT_OVERFLOW, proofTx, 'amount exceeds max_transfer.');
  } else {
    // (7) All checks passed.
    result = approve(proofTx);
  }

  if (seenKey && seen && typeof seen.add === 'function') {
    seen.add(seenKey);
  }
  return result;
}

/** Shape the wire response: only the three fields the platform expects. */
function buildResponse(result) {
  return {
    decision: result.decision,
    reason_code: result.reason_code,
    proof_tx: result.proof_tx || '',
  };
}

module.exports = { decide, buildResponse, REASON_CODES, toBigInt, compareBigInt };
