'use strict';

/**
 * test.js — offline tests for the Gatekeeper v1 (run with `npm test`).
 *
 * No external services, no secrets, no network to the platform.
 * Covers: all 8 scored cases (1 valid + 7 traps), boundary values,
 * malformed input, HMAC sign/verify, seen-set persistence, and the
 * HTTP layer (401 without a signature, 200 + signed response with one,
 * PROOF_REUSED on a replayed proof_tx).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { decide, buildResponse, REASON_CODES } = require('./decision');
const { signHeader, verifySignature, HEADER_NAME } = require('./hmac');
const { SeenSet } = require('./seen');
const { createServer } = require('./server');
const proof = require('./proof');

// Sample payload from https://agentgames.zkverify.io/events/proof-gatekeeper
function makeTask(overrides = {}) {
  const input = {
    registered_vk: '0x7d3a11111111111111111111111111111111111111111111111111111111f291',
    proof_vk: '0x7d3a11111111111111111111111111111111111111111111111111111111f291',
    minimum: '1000',
    public_balance: '1460',
    expiry_block: 19842201,
    current_block: 19832000,
    recipient: '0xDe4200000000000000000000000000000000009f01',
    condition_recipient: '0xDe4200000000000000000000000000000000009f01',
    amount: '500',
    max_transfer: '1000',
    proof_tx: '0xa4c11111111111111111111111111111111111111111111111111111111118ff1',
    ...(overrides.input || {}),
  };
  return {
    type: 'agent-games.proof-gatekeeper.v1',
    task_id: overrides.task_id || 'gk_24_9d1',
    mode: 'competition',
    issued_at: '2026-11-15T09:00:00Z',
    deadline_at: '2026-11-15T09:01:00Z',
    input,
  };
}

function freshSeen() {
  return new Set();
}

function expectDecision(t, task, seen, decision, reasonCode) {
  const r = decide(task, seen);
  assert.equal(r.decision, decision, `${t.name}: expected ${decision}, got ${r.decision} (${r.reason_code})`);
  assert.equal(r.reason_code, reasonCode, `${t.name}: expected ${reasonCode}, got ${r.reason_code}`);
  const wire = buildResponse(r);
  assert.deepEqual(Object.keys(wire).sort(), ['decision', 'proof_tx', 'reason_code']);
  return r;
}

// --- 1 valid + 7 traps -------------------------------------------------
test('1 VALID_CONDITION: all checks pass -> APPROVE', (t) => {
  expectDecision(t, makeTask(), freshSeen(), 'APPROVE', REASON_CODES.VALID_CONDITION);
});

test('2 VK_SUBSTITUTION: proof_vk differs from registered_vk -> REJECT', (t) => {
  const task = makeTask({ input: { proof_vk: '0xa4c10000000000000000000000000000000000000000000000000000000000b8ff' } });
  expectDecision(t, task, freshSeen(), 'REJECT', REASON_CODES.VK_SUBSTITUTION);
});

test('3 THRESHOLD_MISMATCH: public_balance 999 < minimum 1000 -> REJECT', (t) => {
  expectDecision(t, makeTask({ input: { public_balance: '999' } }), freshSeen(), 'REJECT', REASON_CODES.THRESHOLD_MISMATCH);
});

test('4 PROOF_REUSED: same proof_tx sent twice -> second is REJECT', (t) => {
  const seen = freshSeen();
  expectDecision(t, makeTask(), seen, 'APPROVE', REASON_CODES.VALID_CONDITION);
  assert.equal(seen.size, 1);
  expectDecision(t, makeTask({ task_id: 'gk_24_9d2' }), seen, 'REJECT', REASON_CODES.PROOF_REUSED);
});

test('5 EXPIRED_CONDITION: current_block 19842202 > expiry 19842201 -> REJECT', (t) => {
  expectDecision(t, makeTask({ input: { current_block: 19842202 } }), freshSeen(), 'REJECT', REASON_CODES.EXPIRED_CONDITION);
});

test('6 RECIPIENT_MISMATCH: recipient differs -> REJECT', (t) => {
  expectDecision(t, makeTask({ input: { recipient: '0xDe420000000000000000000000000000000000dead' } }), freshSeen(), 'REJECT', REASON_CODES.RECIPIENT_MISMATCH);
});

test('7 AMOUNT_OVERFLOW: amount 1001 > max_transfer 1000 -> REJECT', (t) => {
  expectDecision(t, makeTask({ input: { amount: '1001' } }), freshSeen(), 'REJECT', REASON_CODES.AMOUNT_OVERFLOW);
});

// Trap precedence: reuse is checked before VK, VK before threshold, etc.
test('8 precedence: reused proof with a bad VK still reports PROOF_REUSED', (t) => {
  const seen = freshSeen();
  decide(makeTask(), seen);
  const r = decide(makeTask({ input: { proof_vk: '0xdead' } }), seen);
  assert.equal(r.reason_code, REASON_CODES.PROOF_REUSED);
});

// --- Boundaries (must APPROVE: "meets or exceeds", "up to the cap") ---
test('boundary: balance == minimum, amount == max, current == expiry -> APPROVE', (t) => {
  const task = makeTask({ input: { public_balance: '1000', amount: '1000', current_block: 19842201 } });
  expectDecision(t, task, freshSeen(), 'APPROVE', REASON_CODES.VALID_CONDITION);
});

test('boundary: recipient comparison is case-insensitive -> APPROVE', (t) => {
  const task = makeTask({ input: { recipient: '0xDE4200000000000000000000000000000000009F01' } });
  expectDecision(t, task, freshSeen(), 'APPROVE', REASON_CODES.VALID_CONDITION);
});

test('boundary: large values use BigInt, not float (9007199254740993 > 9007199254740992)', (t) => {
  const task = makeTask({ input: { minimum: '9007199254740992', public_balance: '9007199254740993', amount: '1', max_transfer: '10' } });
  expectDecision(t, task, freshSeen(), 'APPROVE', REASON_CODES.VALID_CONDITION);
  const under = makeTask({ input: { minimum: '9007199254740993', public_balance: '9007199254740992', amount: '1', max_transfer: '10' } });
  expectDecision(t, under, freshSeen(), 'REJECT', REASON_CODES.THRESHOLD_MISMATCH);
});

// --- Malformed input fails closed --------------------------------------
test('malformed: missing input -> REJECT (fail closed)', (t) => {
  const r = decide({ type: 'agent-games.proof-gatekeeper.v1' }, freshSeen());
  assert.equal(r.decision, 'REJECT');
});

test('malformed: missing proof_vk -> VK_SUBSTITUTION REJECT', (t) => {
  const task = makeTask();
  delete task.input.proof_vk;
  expectDecision(t, task, freshSeen(), 'REJECT', REASON_CODES.VK_SUBSTITUTION);
});

test('malformed: unparseable balance -> THRESHOLD_MISMATCH REJECT', (t) => {
  expectDecision(t, makeTask({ input: { public_balance: 'not-a-number' } }), freshSeen(), 'REJECT', REASON_CODES.THRESHOLD_MISMATCH);
});

// --- HMAC ---------------------------------------------------------------
test('hmac: sign/verify round-trip, tampered body and wrong secret fail', (t) => {
  const secret = 'platform-secret-from-rotate-secret';
  const body = Buffer.from(JSON.stringify(makeTask()), 'utf8');
  const header = signHeader(secret, body);
  // Outbound format is bare hex (platform-confirmed 2026-11-15).
  assert.match(header, /^[0-9a-f]{64}$/);
  assert.equal(verifySignature(secret, body, header), true);
  // Inbound verification still accepts the sha256= form and upper case.
  assert.equal(verifySignature(secret, body, `sha256=${header}`), true);
  assert.equal(verifySignature(secret, body, header.toUpperCase()), true);
  assert.equal(verifySignature(secret, Buffer.from('{"tampered":true}'), header), false);
  assert.equal(verifySignature('wrong-secret', body, header), false);
  assert.equal(verifySignature(secret, body, 'sha256=00'), false);
  assert.equal(verifySignature(secret, body, undefined), false);
  assert.equal(verifySignature('', body, header), false);
});

// --- Proof v2 ----------------------------------------------------------
test('proof: v2 status is ready; generateGatekeeperProof validates inputs', async (t) => {
  delete process.env.PROOF_ENABLED;
  assert.equal(proof.PROOF_STATUS, 'ready');
  assert.equal(proof.isProofEnabled(), false);
  process.env.PROOF_ENABLED = 'true';
  t.after(() => { delete process.env.PROOF_ENABLED; });
  assert.equal(proof.isProofEnabled(), true);
  await assert.rejects(() => proof.generateGatekeeperProof({}, 'APPROVE'), /task\.input missing/);
  await assert.rejects(() => proof.generateGatekeeperProof(makeTask({ input: { public_balance: 'junk' } }), 'APPROVE'), /not an integer/);
});

// --- Seen-set persistence ----------------------------------------------
test('seen: persists to JSON and reloads after a restart', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-seen-'));
  const file = path.join(dir, 'seen.json');
  const a = new SeenSet(file);
  assert.equal(a.has('0xABC'), false);
  a.add('0xABC');
  assert.equal(a.has('0xabc'), true); // case-insensitive
  assert.equal(a.size, 1);
  const b = new SeenSet(file); // "restart"
  assert.equal(b.has('0xabc'), true);
  assert.equal(b.size, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- HTTP layer ---------------------------------------------------------
function httpRequest(port, { method, path: p, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('http: /health ok; /task 401 unsigned/bad sig; 200 + signed APPROVE with good sig; replay -> PROOF_REUSED', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-http-'));
  const secret = 'test-platform-secret';
  const { server } = createServer({ secret, seenFile: path.join(dir, 'seen.json'), allowUnsigned: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));

  const health = await httpRequest(port, { method: 'GET', path: '/health' });
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).status, 'ok');

  const task = makeTask();
  // Use a far-future deadline so the deadline guard cannot fire in CI.
  task.deadline_at = new Date(Date.now() + 60_000).toISOString();
  const raw = JSON.stringify(task);

  const unsigned = await httpRequest(port, { method: 'POST', path: '/task', headers: { 'content-type': 'application/json' }, body: raw });
  assert.equal(unsigned.status, 401);

  const badSig = await httpRequest(port, { method: 'POST', path: '/task', headers: { 'content-type': 'application/json', [HEADER_NAME]: signHeader('wrong-secret', raw) }, body: raw });
  assert.equal(badSig.status, 401);

  const ok = await httpRequest(port, { method: 'POST', path: '/task', headers: { 'content-type': 'application/json', [HEADER_NAME]: signHeader(secret, raw) }, body: raw });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).decision, 'APPROVE');
  assert.equal(JSON.parse(ok.body).reason_code, 'VALID_CONDITION');
  assert.ok(ok.headers[HEADER_NAME], 'response must carry x-agent-games-signature');
  assert.equal(verifySignature(secret, Buffer.from(ok.body, 'utf8'), ok.headers[HEADER_NAME]), true);

  const replay = await httpRequest(port, { method: 'POST', path: '/task', headers: { 'content-type': 'application/json', [HEADER_NAME]: signHeader(secret, raw) }, body: raw });
  assert.equal(replay.status, 200);
  assert.equal(JSON.parse(replay.body).decision, 'REJECT');
  assert.equal(JSON.parse(replay.body).reason_code, 'PROOF_REUSED');

  const seenOnDisk = JSON.parse(fs.readFileSync(path.join(dir, 'seen.json'), 'utf8'));
  assert.ok(seenOnDisk.proof_tx.includes(task.input.proof_tx.toLowerCase()));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('http: signed preflight probe -> 200 { ok: true, protocolVersion: "v1" }, signed', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-preflight-'));
  const secret = 'test-platform-secret';
  const { server } = createServer({ secret, seenFile: path.join(dir, 'seen.json'), allowUnsigned: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));

  const probeBody = JSON.stringify({ type: 'agent-games.preflight.v1', agent_id: '28273fac-a1bc-4212-a8bc-c0f2f09e990e', issued_at: new Date().toISOString(), nonce: '72de5ccc-a9a6-48bb-b1c8-9aa9839ef714' });
  const pre = await httpRequest(port, { method: 'POST', path: '/task', headers: { 'content-type': 'application/json', [HEADER_NAME]: signHeader(secret, probeBody) }, body: probeBody });
  assert.equal(pre.status, 200);
  assert.deepEqual(JSON.parse(pre.body), { ok: true, protocolVersion: 'v1' });
  assert.ok(pre.headers[HEADER_NAME], 'preflight response must carry x-agent-games-signature');
  assert.equal(verifySignature(secret, Buffer.from(pre.body, 'utf8'), pre.headers[HEADER_NAME]), true);

  // Unsigned probe still 401; other signed non-task bodies still 200 (reject).
  const unsignedProbe = await httpRequest(port, { method: 'POST', path: '/task', headers: { 'content-type': 'application/json' }, body: probeBody });
  assert.equal(unsignedProbe.status, 401);
  const emptyProbe = await httpRequest(port, { method: 'POST', path: '/task', headers: { 'content-type': 'application/json', [HEADER_NAME]: signHeader(secret, '') }, body: '' });
  assert.equal(emptyProbe.status, 200);
  assert.equal(JSON.parse(emptyProbe.body).decision, 'REJECT');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Proof generation (v2): encodings, proving, verification -----------
// Reference values: @dyors' published public signals for the sample
// task (dev.to, 2026-11-16), reproduced here from the raw inputs.
const PLATFORM_VK = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';
const DYORS_VK_FIELD = '4836144126773920907502496244340012141761656471453348073975163706578152814510';
const DYORS_TASKID_FIELD = '16506844760414165912080236586659340220318748946289526529754881394918275529611';

test('proof: keccak256 vectors (empty string + sample task_id)', (t) => {
  const { keccak256Hex } = require('./keccak');
  assert.equal(keccak256Hex(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  const taskIdField = proof.taskIdToField('gk_24_9d1').toString();
  assert.equal(taskIdField, DYORS_TASKID_FIELD, 'keccak256("gk_24_9d1") mod p must equal dyors public signal [12]');
  assert.notEqual(taskIdField, '20829714751891584743724278765307997780450844889094878994196554839611267657343', 'must NOT be the SHA-256 value');
});

test('proof: buildCircuitInput encodes VK hashes + task_id exactly as the published proof', (t) => {
  const task = makeTask({ input: { registered_vk: PLATFORM_VK, proof_vk: PLATFORM_VK } });
  const input = proof.buildCircuitInput(task, 'APPROVE');
  assert.equal(input.registeredVkHash, DYORS_VK_FIELD);
  assert.equal(input.proofVkHash, DYORS_VK_FIELD);
  assert.equal(input.taskId, DYORS_TASKID_FIELD);
  assert.equal(input.minimum, '1000');
  assert.equal(input.publicBalance, '1460');
  assert.equal(input.expiryBlock, '19842201');
  assert.equal(input.currentBlock, '19832000');
  assert.equal(input.recipient, BigInt('0xDe4200000000000000000000000000000000009f01').toString());
  assert.equal(input.conditionRecipient, input.recipient);
  assert.equal(input.amount, '500');
  assert.equal(input.maxTransfer, '1000');
  assert.equal(input.decision, '1');
  assert.match(input.salt, /^[0-9]+$/);
  assert.notEqual(input.salt, '0');
  // A second build uses a fresh salt (private, random per proof).
  assert.notEqual(proof.buildCircuitInput(task, 'APPROVE').salt, input.salt);
  const rejectInput = proof.buildCircuitInput(task, 'REJECT');
  assert.equal(rejectInput.decision, '0');
});

test('proof: valid APPROVE generates a proof that verifies; public signals match the task', async (t) => {
  const task = makeTask({ input: { registered_vk: PLATFORM_VK, proof_vk: PLATFORM_VK } });
  task.deadline_at = new Date(Date.now() + 60_000).toISOString();
  const { proof: grothProof, publicSignals, proofMs } = await proof.generateGatekeeperProof(task, 'APPROVE');
  console.log(`[test] valid APPROVE proof: ${proofMs}ms`);
  assert.ok(proofMs < 30_000, `proving took ${proofMs}ms, must fit comfortably inside the 60 s deadline`);
  assert.equal(publicSignals.length, 13);
  assert.equal(publicSignals[1], DYORS_VK_FIELD);
  assert.equal(publicSignals[2], DYORS_VK_FIELD);
  assert.deepEqual(publicSignals.slice(3, 12), ['1000', '1460', '19842201', '19832000', BigInt('0xDe4200000000000000000000000000000000009f01').toString(), BigInt('0xDe4200000000000000000000000000000000009f01').toString(), '500', '1000', '1']);
  assert.equal(publicSignals[12], DYORS_TASKID_FIELD);
  assert.match(publicSignals[0], /^[0-9]+$/, 'public signal [0] is the Poseidon commitment, a field element');
  const snarkjs = require('snarkjs');
  assert.equal(await snarkjs.groth16.verify(proof.loadVerificationKey(), publicSignals, grothProof), true);
});

test('proof: correct REJECT of a trap (recipient mismatch) also proves and verifies', async (t) => {
  const task = makeTask({ input: { registered_vk: PLATFORM_VK, proof_vk: PLATFORM_VK, recipient: '0xDe420000000000000000000000000000000000dead' } });
  task.deadline_at = new Date(Date.now() + 60_000).toISOString();
  const { proof: grothProof, publicSignals, proofMs } = await proof.generateGatekeeperProof(task, 'REJECT');
  console.log(`[test] trap REJECT proof: ${proofMs}ms`);
  assert.ok(proofMs < 30_000);
  assert.equal(publicSignals[11], '0');
  const snarkjs = require('snarkjs');
  assert.equal(await snarkjs.groth16.verify(proof.loadVerificationKey(), publicSignals, grothProof), true);
});

test('proof: wrong decisions are unprovable — fullProve throws (circuit assert)', async (t) => {
  const valid = makeTask({ input: { registered_vk: PLATFORM_VK, proof_vk: PLATFORM_VK } });
  await assert.rejects(() => proof.generateGatekeeperProof(valid, 'REJECT'), /Assert Failed|Failed/i);
  const trap = makeTask({ input: { registered_vk: PLATFORM_VK, proof_vk: PLATFORM_VK, amount: '1001' } });
  await assert.rejects(() => proof.generateGatekeeperProof(trap, 'APPROVE'), /Assert Failed|Failed/i);
});

test('proof: timeout budget is enforced (1 ms budget rejects instead of hanging)', async (t) => {
  const task = makeTask({ input: { registered_vk: PLATFORM_VK, proof_vk: PLATFORM_VK } });
  await assert.rejects(() => proof.generateGatekeeperProof(task, 'APPROVE', { timeoutMs: 1 }), /exceeded 1ms/);
});

test('http: PROOF_ENABLED=true -> valid task answers APPROVE with verifying proof + public_signals; replay -> PROOF_REUSED with NO proof', async (t) => {
  process.env.PROOF_ENABLED = 'true';
  t.after(() => { delete process.env.PROOF_ENABLED; });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-proof-http-'));
  const secret = 'test-platform-secret';
  const { server } = createServer({ secret, seenFile: path.join(dir, 'seen.json'), allowUnsigned: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));

  const task = makeTask({ input: { registered_vk: PLATFORM_VK, proof_vk: PLATFORM_VK } });
  task.deadline_at = new Date(Date.now() + 60_000).toISOString();
  const raw = JSON.stringify(task);
  const headers = { 'content-type': 'application/json', [HEADER_NAME]: signHeader(secret, raw) };

  const okRes = await httpRequest(port, { method: 'POST', path: '/task', headers, body: raw });
  assert.equal(okRes.status, 200);
  const body = JSON.parse(okRes.body);
  assert.equal(body.decision, 'APPROVE');
  assert.equal(body.reason_code, 'VALID_CONDITION');
  assert.equal(body.proof_tx, task.input.proof_tx);
  assert.ok(body.proof, 'response must include proof');
  assert.equal(body.proof.protocol, 'groth16');
  assert.ok(Array.isArray(body.public_signals) && body.public_signals.length === 13, 'response must include 13 public_signals');
  assert.equal(body.public_signals[12], DYORS_TASKID_FIELD);
  const snarkjs = require('snarkjs');
  assert.equal(await snarkjs.groth16.verify(proof.loadVerificationKey(), body.public_signals, body.proof), true, 'proof in the HTTP response must verify (platform-side check)');
  assert.equal(verifySignature(secret, Buffer.from(okRes.body, 'utf8'), okRes.headers[HEADER_NAME]), true, 'proof-carrying response must still be HMAC-signed');

  const replay = await httpRequest(port, { method: 'POST', path: '/task', headers, body: raw });
  assert.equal(JSON.parse(replay.body).decision, 'REJECT');
  assert.equal(JSON.parse(replay.body).reason_code, 'PROOF_REUSED');
  assert.equal(JSON.parse(replay.body).proof, undefined, 'PROOF_REUSED carries no proof');
  assert.equal(JSON.parse(replay.body).public_signals, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('http: PROOF_ENABLED=true but unprovable task (missing proof_vk) -> decision-only REJECT, no crash, no proof field', async (t) => {
  process.env.PROOF_ENABLED = 'true';
  t.after(() => { delete process.env.PROOF_ENABLED; });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gk-proof-fallback-'));
  const secret = 'test-platform-secret';
  const { server } = createServer({ secret, seenFile: path.join(dir, 'seen.json'), allowUnsigned: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));

  const task = makeTask();
  delete task.input.proof_vk;
  task.deadline_at = new Date(Date.now() + 60_000).toISOString();
  const raw = JSON.stringify(task);
  const res = await httpRequest(port, { method: 'POST', path: '/task', headers: { 'content-type': 'application/json', [HEADER_NAME]: signHeader(secret, raw) }, body: raw });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.decision, 'REJECT');
  assert.equal(body.reason_code, 'VK_SUBSTITUTION');
  assert.equal(body.proof, undefined);
  assert.equal(body.public_signals, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});
