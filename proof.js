'use strict';

/**
 * proof.js — Groth16 proof generation v2 (LIVE since 2026-11-19).
 *
 * The agent generates a Groth16 proof LOCALLY with snarkjs + the
 * official gatekeeper circuit and returns it in the signed response:
 *
 *   { decision, reason_code, proof_tx, proof, public_signals }
 *
 * No Kurier / on-chain submission: the platform re-verifies the proof
 * itself against its registered key (offline verification). Evidence
 * for the format — three independent live agents with platform
 * "proof VERIFIED" receipts in Practice Mode, all using exactly this
 * shape (checked 2026-11-19):
 *   - github.com/lince00/agent-games-gatekeeper (server.mjs):
 *     `response.proof = proof; response.public_signals = publicSignals`
 *     — practice amount-overflow trap REJECT marked VERIFIED, 498 ms.
 *   - github.com/hitokarumashaki/agent-games (src/prover.js + handler):
 *     "the platform accepts proof plus public signals alone, no
 *     on-chain submission needed. The Kurier integration is an
 *     unimplemented stub; nothing was spent on-chain." 5/5 practice
 *     tasks CORRECT with proofs VERIFIED.
 *   - github.com/District-X/agent-games-zkverify (lib/gatekeeper.js):
 *     "returns { decision, reason_code, proof, public_signals }" —
 *     3/3 practice tasks proof VERIFIED (712/621/702 ms).
 * The /build guide §02.5 says the same thing in its own words:
 * "generate proofs locally with snarkjs, and include the proof in
 * your response." The event page's "Expected response shape" shows
 * only the three decision fields because the proof fields are
 * additional, not alternative.
 *
 * Scoring effect (event page): a correct decision WITH a verifying
 * proof scores +12 and counts toward the +0..+5 reliability bonus;
 * without a valid proof it scores +10 (extra -2) and no bonus.
 * A proof that fails to verify costs the same -2 as no proof — so
 * including a proof can never score worse than v1 decision-only.
 *
 * Circuit facts (from https://agentgames.zkverify.io/api/circuit-info
 * and the downloaded artifacts, verified locally 2026-11-19):
 *   - Groth16/BN128, Circom 2.x, template GatekeeperEvaluation_79,
 *     647 witness signals, 13 public signals.
 *   - gatekeeper.wasm 1,755,820 bytes sha256 be00aefe…
 *     gatekeeper_final.zkey 309,750 bytes sha256 adfe95a4…
 *   - vkHash 0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0
 *   - 13 input signals (NOT published by the platform; recovered by
 *     probing the compiled wasm — same 13 names in all three repos
 *     above and in @dyors' battery):
 *       registeredVkHash, proofVkHash, minimum, publicBalance,
 *       expiryBlock, currentBlock, recipient, conditionRecipient,
 *       amount, maxTransfer, decision, taskId, salt (private)
 *   - Public signals, output-then-public order (computed by snarkjs,
 *     never assembled by hand):
 *       [ Poseidon(salt, taskId) commitment, registeredVkHash,
 *         proofVkHash, minimum, publicBalance, expiryBlock,
 *         currentBlock, recipient, conditionRecipient, amount,
 *         maxTransfer, decision, taskId ]  (taskId LAST)
 *   - The circuit asserts decision == (all five field checks pass):
 *     VK match, threshold, recipient, amount cap, expiry. A wrong
 *     decision cannot build a witness at all — fullProve throws.
 *     A correct REJECT of a trap DOES prove (decision 0, checks fail).
 *
 * Field encodings (verified numerically 2026-11-19 against @dyors'
 * published public signals for the sample task):
 *   - VK hashes: BigInt(0x-hex) mod p — reproduces dyors' signal [1]
 *     4836144126773920907502496244340012141761656471453348073975163706578152814510
 *     from 0x6b79c601…d77b0 exactly.
 *   - taskId: keccak256(task_id UTF-8) mod p — reproduces dyors'
 *     signal [12] 16506844760414165912080236586659340220318748946289526529754881394918275529611
 *     from "gk_24_9d1" exactly. (SHA-256 of the same string gives a
 *     different value, so keccak256 — not SHA-256 — is the encoding.)
 *   - addresses: plain BigInt(0x-hex); amounts/blocks: decimal strings.
 *   - salt: fresh random 128-bit value per proof. Private — never
 *     logged, never returned, never reused across tasks.
 *
 * HONEST CAVEAT — taskId encoding: the platform never published the
 * string->field encoding, and the three repos above disagree
 * (keccak256 / SHA-256 / raw UTF-8 bytes). keccak256 is used here
 * because it has the strongest support: two of the three repos, the
 * Ethereum-native choice, and an exact reproduction of a published
 * proof's public signals. Practice Mode marks proofs VERIFIED under
 * all three encodings, which shows practice checks proof validity
 * (groth16.verify) rather than recomputing public signals from the
 * task — so practice cannot discriminate. If the platform recomputes
 * expected signals at round close, keccak256 is the most likely
 * match; if it only runs groth16.verify, any encoding works. Either
 * way the worst case is the v1 outcome (-2, no bonus), never worse.
 *
 * PROOF_REUSED tasks get NO proof: the scoring rules exclude them,
 * and the circuit cannot prove rejecting an otherwise-valid condition
 * anyway (decision 0 + all checks pass = no witness). handler.js
 * skips proof generation for that reason_code.
 *
 * Failure policy: generateGatekeeperProof() THROWS on any failure
 * (bad inputs, witness assertion for a wrong decision, timeout,
 * missing artifacts). The caller (handler.js) MUST catch it and
 * answer decision-only — never crash, never exceed the deadline.
 * Proof generation is capped at PROOF_TIMEOUT_MS (45 s) via a race;
 * typical proving time on this VM is ~1 s (measured in test.js).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { keccak256Hex } = require('./keccak');
const { toBigInt } = require('./decision');

const FIELD_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const CIRCUIT_INFO = Object.freeze({
  network: 'mainnet',
  gatekeeper: Object.freeze({
    vkHash: '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0',
    wasm: 'https://agentgames.zkverify.io/circuits/gatekeeper.wasm',
    zkey: 'https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey',
  }),
  // Steal-the-VFY policy circuit, listed for reference only (not this agent):
  vfyPolicy: Object.freeze({
    vkHash: '0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047',
    wasm: 'https://agentgames.zkverify.io/circuits/vfy-policy.wasm',
    zkey: 'https://agentgames.zkverify.io/circuits/vfy-policy_final.zkey',
  }),
});

const PROOF_STATUS = 'ready';
const PROOF_TIMEOUT_MS = 45_000;
const EXPECTED_PUBLIC_SIGNALS = 13;

const CIRCUITS_DIR = process.env.CIRCUITS_DIR || path.join(__dirname, 'circuits');
const WASM_PATH = path.join(CIRCUITS_DIR, 'gatekeeper.wasm');
const ZKEY_PATH = path.join(CIRCUITS_DIR, 'gatekeeper_final.zkey');
const VK_PATH = path.join(CIRCUITS_DIR, 'verification_key.json');

let vkCache = null;

function isProofEnabled() {
  return process.env.PROOF_ENABLED === 'true';
}

function getProofStatus() {
  return {
    status: PROOF_STATUS,
    enabled: isProofEnabled(),
    circuit: CIRCUIT_INFO.gatekeeper,
    timeout_ms: PROOF_TIMEOUT_MS,
    note: 'v2 generates a local Groth16 proof per provable decision (snarkjs + official gatekeeper circuit) and returns { proof, public_signals } in the signed response. PROOF_REUSED tasks carry no proof. Any proof failure falls back to decision-only.',
  };
}

function modP(x) {
  const r = x % FIELD_P;
  return r >= 0n ? r : r + FIELD_P;
}

/** 0x-prefixed 32-byte hash -> field element (BigInt mod p). */
function toFieldFromHashHex(value, field) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value.trim())) {
    throw new Error(`buildCircuitInput: ${field} must be a 0x hex string, got ${String(value).slice(0, 40)}`);
  }
  return modP(BigInt(value.trim()));
}

/** Decimal string / number / bigint -> field element (exact; throws on junk). */
function toFieldFromNumberLike(value, field) {
  const v = toBigInt(value);
  if (v === null) throw new Error(`buildCircuitInput: ${field} is not an integer: ${String(value).slice(0, 40)}`);
  if (v < 0n) throw new Error(`buildCircuitInput: ${field} must be non-negative`);
  return v;
}

/** 0x address (160-bit) -> field element (fits the field, no reduction needed). */
function addressToField(value, field) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value.trim())) {
    throw new Error(`buildCircuitInput: ${field} must be a 0x address, got ${String(value).slice(0, 40)}`);
  }
  return BigInt(value.trim());
}

/**
 * task_id -> field element. Numeric / 0x ids are used directly (mod p);
 * free-form ids (e.g. "gk_24_9d1") are keccak256(utf8) mod p.
 * See the header caveat: keccak256 is the best-supported encoding.
 */
function taskIdToField(taskId) {
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new Error('buildCircuitInput: task_id must be a non-empty string');
  }
  const s = taskId.trim();
  if (/^0x[0-9a-fA-F]+$/.test(s)) return modP(BigInt(s));
  if (/^[0-9]+$/.test(s)) return modP(BigInt(s));
  return modP(BigInt(keccak256Hex(s)));
}

/** Fresh random 128-bit private salt per proof (never logged/returned). */
function deriveSalt() {
  return modP(BigInt('0x' + crypto.randomBytes(16).toString('hex')));
}

/**
 * Build the 13 circuit inputs from a task envelope + decision.
 * Values are decimal strings (field elements). Throws on any missing
 * or unparseable field — the caller falls back to decision-only.
 */
function buildCircuitInput(task, decision) {
  const input = task && typeof task === 'object' ? task.input : null;
  if (!input || typeof input !== 'object') {
    throw new Error('buildCircuitInput: task.input missing or invalid');
  }
  const required = (name) => {
    const v = input[name];
    if (v === undefined || v === null || v === '') throw new Error(`buildCircuitInput: missing ${name}`);
    return v;
  };
  return {
    registeredVkHash: toFieldFromHashHex(required('registered_vk'), 'registered_vk').toString(),
    proofVkHash: toFieldFromHashHex(required('proof_vk'), 'proof_vk').toString(),
    minimum: toFieldFromNumberLike(required('minimum'), 'minimum').toString(),
    publicBalance: toFieldFromNumberLike(required('public_balance'), 'public_balance').toString(),
    expiryBlock: toFieldFromNumberLike(required('expiry_block'), 'expiry_block').toString(),
    currentBlock: toFieldFromNumberLike(required('current_block'), 'current_block').toString(),
    recipient: addressToField(required('recipient'), 'recipient').toString(),
    conditionRecipient: addressToField(required('condition_recipient'), 'condition_recipient').toString(),
    amount: toFieldFromNumberLike(required('amount'), 'amount').toString(),
    maxTransfer: toFieldFromNumberLike(required('max_transfer'), 'max_transfer').toString(),
    decision: decision === 'APPROVE' ? '1' : '0',
    taskId: taskIdToField(task.task_id).toString(),
    salt: deriveSalt().toString(),
  };
}

function loadVerificationKey() {
  if (!vkCache) {
    vkCache = JSON.parse(fs.readFileSync(VK_PATH, 'utf8'));
  }
  return vkCache;
}

/**
 * Generate a Groth16 proof for a decision.
 * @param {object} task - task envelope (task.input holds the fields)
 * @param {'APPROVE'|'REJECT'} decision - the decision from decide()
 * @param {object} [opts] - { timeoutMs } (default PROOF_TIMEOUT_MS)
 * @returns {Promise<{proof: object, publicSignals: string[], proofMs: number}>}
 * @throws on any failure: bad inputs, witness assertion (wrong
 *   decision — unprovable by design), timeout, missing artifacts,
 *   or a locally failing re-verification. Callers MUST catch and
 *   answer decision-only.
 */
async function generateGatekeeperProof(task, decision, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? PROOF_TIMEOUT_MS;
  const inputs = buildCircuitInput(task, decision);
  // Lazy require: /health and preflight never pay the snarkjs load cost.
  const snarkjs = require('snarkjs');
  const t0 = Date.now();
  const work = (async () => {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(inputs, WASM_PATH, ZKEY_PATH);
    if (!Array.isArray(publicSignals) || publicSignals.length !== EXPECTED_PUBLIC_SIGNALS) {
      throw new Error(`expected ${EXPECTED_PUBLIC_SIGNALS} public signals, got ${Array.isArray(publicSignals) ? publicSignals.length : typeof publicSignals}`);
    }
    // Re-verify locally before the proof leaves the box.
    const ok = await snarkjs.groth16.verify(loadVerificationKey(), publicSignals, proof);
    if (!ok) throw new Error('local groth16 verification failed');
    return { proof, publicSignals: publicSignals.map(String), proofMs: Date.now() - t0 };
  })();
  let timer = null;
  const timerPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`proof generation exceeded ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([work, timerPromise]);
  } finally {
    // Never leak the 45 s timer into the event loop after settling.
    if (timer !== null) clearTimeout(timer);
  }
}

module.exports = {
  CIRCUIT_INFO,
  PROOF_STATUS,
  PROOF_TIMEOUT_MS,
  EXPECTED_PUBLIC_SIGNALS,
  FIELD_P,
  isProofEnabled,
  getProofStatus,
  buildCircuitInput,
  taskIdToField,
  loadVerificationKey,
  generateGatekeeperProof,
};
