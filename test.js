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

// --- Proof stub ---------------------------------------------------------
test('proof: v1 stub is explicit — generateGatekeeperProof throws, never fakes', async (t) => {
  assert.equal(proof.PROOF_STATUS, 'not-implemented');
  assert.equal(proof.isProofEnabled(), false);
  await assert.rejects(() => proof.generateGatekeeperProof({}, {}), /NOT IMPLEMENTED/);
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
  t.after(() => new Promise((resolve) => server.close(resolve)));

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
  t.after(() => new Promise((resolve) => server.close(resolve)));

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
