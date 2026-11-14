'use strict';

/**
 * proof.js — Groth16 proof generation STUB (NOT ACTIVE in v1).
 *
 * DO NOT treat v1 decisions as proof-backed. Per the event page, a
 * correct decision answered without a valid Groth16 proof earns no
 * reliability bonus (+0..+5) and costs an extra -2. That is the known
 * cost of shipping decision-only v1 first; the decision logic is
 * still correct, it just scores lower than a proof-backed agent.
 *
 * NEVER fake a proof: the platform re-verifies every proof against its
 * own registered key, so a fabricated proof is wasted work at best and
 * a trust/scoring problem at worst.
 *
 * What v2 needs (all from https://agentgames.zkverify.io/build §02.5/§03
 * and https://agentgames.zkverify.io/api/circuit-info, checked 14 Nov 2026):
 *   - Circuit artifacts (Groth16/BN128, Circom 2.x):
 *       gatekeeper wasm: https://agentgames.zkverify.io/circuits/gatekeeper.wasm
 *       gatekeeper zkey: https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey
 *       gatekeeper vkHash (registered on zkVerify mainnet):
 *         0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0
 *   - `snarkjs` to generate proofs locally from the .zkey + .wasm.
 *   - Kurier (recommended by the guide): a mainnet API key, register the
 *     verification key once, submit the proof with its vkHash, poll
 *     until the job reaches Finalized — only then return it as confirmed.
 *     (Alternative: zkVerifyJS direct chain interaction with a funded
 *     Volta session — needs funds, NOT in scope for this free build.)
 *   - The exact public inputs / circuit inputs for the gatekeeper
 *     circuit — read them from the circuit artifacts / practice tasks
 *     during preflight; do not guess them.
 *
 * Until all of that is wired in, generateGatekeeperProof() throws.
 * server.js calls it only when PROOF_ENABLED=true, and even then the
 * throw is caught and the task is answered decision-only (with the
 * limitation logged) rather than crashing the round.
 */
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

const PROOF_STATUS = 'not-implemented';

function isProofEnabled() {
  return process.env.PROOF_ENABLED === 'true';
}

function getProofStatus() {
  return {
    status: PROOF_STATUS,
    enabled: isProofEnabled(),
    circuit: CIRCUIT_INFO.gatekeeper,
    note: 'v1 is decision-only. No proof is generated or submitted.',
  };
}

/**
 * @throws always in v1 — see header comment for what v2 must do.
 */
async function generateGatekeeperProof(/* task, decision */) {
  throw new Error(
    'Proof generation NOT IMPLEMENTED in v1 (decision-only). ' +
    'Needs snarkjs + gatekeeper.wasm + gatekeeper_final.zkey + a Kurier mainnet API key. ' +
    'See proof.js header and README.md § Proof (v1 limitation).'
  );
}

module.exports = { CIRCUIT_INFO, PROOF_STATUS, isProofEnabled, getProofStatus, generateGatekeeperProof };
