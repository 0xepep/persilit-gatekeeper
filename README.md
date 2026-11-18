# Proof Gatekeeper — zkVerify Agent Games (v2, proof-backed)

Agent untuk track **Proof Gatekeeper** di [Agent Games](https://agentgames.zkverify.io)
(cek sumber: 14 Nov 2026). Menjawab task approve/reject pembayaran berbasis
ZK proof. **v2 menghasilkan proof Groth16 lokal per keputusan (snarkjs +
circuit resmi) dan mengembalikannya di response** (lihat § Proof di bawah).

## Status kompetisi (terverifikasi 14 Nov 2026)

- Hadiah track ini: 100.000 VFY (1st 50.000 / 2nd 30.000 / 3rd 20.000).
  Total pool semua track 400.000 VFY. Entry gratis, semua track tutup 21 Nov 2026.
- Ronde: 8 ronde harian, 8 task/agent/hari, skor kumulatif.
  Ronde 1 (13 Nov) dan Ronde 2 (14 Nov) sudah lewat. Agent `persilit`
  terdaftar 15 Nov 2026 (repo
  https://github.com/0xepep/persilit-gatekeeper). **Target realistis:
  ronde 3–8, 15–20 Nov 2026.**
- Jam arena: 16:00–02:00 IST tiap hari = **17:30–03:30 WIB**.
- Skor per keputusan: benar +12, salah approve −6, salah reject −3,
  timeout −2. Tanpa proof Groth16 yang valid: −2 ekstra + tanpa bonus
  reliabilitas (+0..+5).

## Yang dilakukan agent ini

`POST /task` menerima envelope JSON, memverifikasi HMAC atas raw body
**sebelum** parse, memutuskan, lalu menandatangani response dengan
`x-agent-games-signature` atas raw response body. Deadline 60 detik;
fail-closed: ketidakpastian = REJECT.

### Urutan cek (decision.js)

1. `proof_tx` sudah di seen-set → `PROOF_REUSED` REJECT
2. `proof_vk != registered_vk` → `VK_SUBSTITUTION` REJECT
3. `public_balance < minimum` → `THRESHOLD_MISMATCH` REJECT
4. `current_block > expiry_block` → `EXPIRED_CONDITION` REJECT
5. `recipient != condition_recipient` → `RECIPIENT_MISMATCH` REJECT
6. `amount > max_transfer` → `AMOUNT_OVERFLOW` REJECT
7. Semua lolos → `VALID_CONDITION` APPROVE

Response wire (hanya 3 field ini):

```json
{"decision": "APPROVE", "reason_code": "VALID_CONDITION", "proof_tx": "0xa4c1...8ff1"}
```

Detail/pembanding memakai `BigInt` (bukan float) — penting karena nilai
bisa melebihi `Number.MAX_SAFE_INTEGER`. Batas inklusif: balance == minimum
APPROVE, amount == max_transfer APPROVE, current == expiry APPROVE.
Perbandingan alamat case-insensitive. Field hilang/tidak bisa di-parse =
fail-closed pada langkah yang membutuhkannya (terdokumentasi di
`decision.js`, dites di `test.js`).

## File

| File | Isi |
|---|---|
| `server.js` | HTTP server zero-dependency: `POST /task`, `GET /health`, `GET /` (wrapper tipis di atas `handler.js`) |
| `handler.js` | Inti request (HMAC, parse, decide, sign) — dipakai `server.js` dan `api/handler.js`, perilaku identik |
| `api/handler.js` | Entry serverless Vercel (`/`, `/health`, `/task` di-rewrite ke sini) |
| `vercel.json` | Rewrites Vercel: `/`, `/health`, `/task` → `/api/handler` |
| `decision.js` | Logika murni (tanpa I/O) — mudah dites |
| `hmac.js` | HMAC-SHA256 sign/verify (`sha256=<hex>`, timing-safe) |
| `seen.js` | Seen-set `proof_tx`: in-memory + persist ke JSON (atomic rename) |
| `proof.js` | **Proof Groth16 v2 — generate + verifikasi lokal via `snarkjs`, fallback decision-only** |
| `test.js` | 18 test offline (`npm test`), tanpa jaringan/platform |
| `.env.example` | Template env (tanpa secret asli) |
| `data/seen.json` | Dibuat otomatis saat jalan; JANGAN commit (sudah di `.gitignore`) |

## Jalankan lokal

Butuh Node.js ≥ 18. Tanpa dependensi — `npm install` tidak diperlukan.

```bash
cd gatekeeper
cp .env.example .env   # lalu isi AGENT_GAMES_HMAC_SECRET dari dashboard
npm test               # wajib PASS dulu
npm start              # listen di http://0.0.0.0:3000
```

Mode dev tanpa secret (hanya lokal, JANGAN di endpoint terdaftar):

```bash
ALLOW_UNSIGNED_TASKS=true PORT=3101 npm start
curl -s http://127.0.0.1:3101/health
```

Contoh task valid (bawa dari halaman event):

```bash
curl -s -X POST http://127.0.0.1:3101/task -H 'content-type: application/json' -d \
'{"type":"agent-games.proof-gatekeeper.v1","task_id":"gk_24_9d1","mode":"practice",
"issued_at":"2026-11-15T09:00:00Z","deadline_at":"2099-01-01T00:00:00Z",
"input":{"registered_vk":"0x7d3a...f291","proof_vk":"0x7d3a...f291","minimum":"1000",
"public_balance":"1460","expiry_block":19842201,"current_block":19832000,
"recipient":"0xDe42...9f01","condition_recipient":"0xDe42...9f01",
"amount":"500","max_transfer":"1000","proof_tx":"0xa4c1...8ff1"}}'
# -> {"decision":"APPROVE","reason_code":"VALID_CONDITION","proof_tx":"0xa4c1...8ff1"}
```

### Env

| Variabel | Wajib | Keterangan |
|---|---|---|
| `AGENT_GAMES_HMAC_SECRET` | Ya (produksi) | Nilai dari dashboard platform: **Rotate Secret**. Jangan hardcode, jangan pakai placeholder sebagai secret asli |
| `ALLOW_UNSIGNED_TASKS` | Tidak | `true` hanya untuk dev lokal. Di endpoint terdaftar harus `false`/unset |
| `PORT` | Tidak | Default `3000` |
| `HOST` | Tidak | Default `0.0.0.0` |
| `SEEN_FILE` | Tidak | Default `./data/seen.json` |
| `PROOF_ENABLED` | Tidak | `true` di production (Vercel). Lihat § Proof |

**Tanpa secret:** `POST /task` menjawab 401 (`hmac_not_configured`),
kecuali `ALLOW_UNSIGNED_TASKS=true`. Signature salah/hilang juga 401 —
tanpa keputusan apa pun.

## Deploy ke HTTPS gratis (dipilih: Vercel Hobby)

Dipilih 15 Nov 2026 setelah **Render mentok: Render wajibkan kartu kredit
untuk verifikasi identitas** (otorisasi sementara $1) bahkan untuk Free
tier — muncul saat klik "Deploy web service". Vercel Hobby gratis dan
**tidak minta kartu**. Server ini diadaptasi ke serverless Vercel tanpa
mengubah logika keputusan: `handler.js` (inti, dipakai `server.js` dan
`api/handler.js`), `vercel.json` me-rewrite `/`, `/health`, `/task` ke
`/api/handler`.

Kenapa Vercel: HTTPS otomatis + deploy dari Git + env vars di dashboard
+ cold start serverless biasanya < 1 detik (jauh di bawah deadline 60
detik). Catatan: tiap invocasi bisa jalan di instance berbeda, dan
`/tmp` hanya hidup per instance — `SEEN_FILE=/tmp/seen.json` bisa
kosong di instance dingin. Itu risiko PROOF_REUSED terlewat. Mitigasi:
jangan redeploy di tengah ronde; untuk v1.1, pindahkan seen-set ke
KV/Redis gratis.

Langkah (repo sudah di GitHub, agent sudah terdaftar):

1. Di [vercel.com](https://vercel.com): sign in dengan GitHub 0xepep
   → Add New → Project → Import `0xepep/persilit-gatekeeper`.
   Framework Preset: Other. Build Command: kosong (tanpa dependensi).
   Root Directory: repo root (bukan `gatekeeper/`, karena `api/`,
   `vercel.json`, dan `server.js` ada di root repo).
2. Environment Variables → tambah:
   `SEEN_FILE` = `/tmp/seen.json`,
   `ALLOW_UNSIGNED_TASKS` = `false`,
   `PROOF_ENABLED` = `false`.
   `AGENT_GAMES_HMAC_SECRET` diisi nanti (lihat langkah 3).
   Jangan set `ALLOW_UNSIGNED_TASKS=true` di Vercel.
3. Deploy → tunggu `Ready` → cek
   `https://persilit-gatekeeper.vercel.app/health` harus
   `{"status":"ok",...}` (saat ini `hmac_configured: false` — normal
   sebelum secret diisi).
4. Lanjut ke checklist preflight di bawah.

## Checklist preflight + practice (dari situs — butuh user/dashboard)

Syarat entry dari halaman event (semua harus centang sebelum ronde):

- [ ] Akun ter-autentikasi + identitas prize-eligibility (login X di
      https://agentgames.zkverify.io, lengkapi handle/country/bio;
      wallet opsional saat daftar, **wajib saat klaim hadiah**)
- [ ] Endpoint HTTPS terdaftar + lolos health check
- [ ] Signed preflight selesai + minimal 1 practice task
- [ ] Endpoint merespons < 60 detik di bawah beban
- [ ] 1 agent per owner di event ini; entry terkunci saat ronde terbuka

Urutan yang disarankan:

1. Deploy ke Vercel (di atas), verifikasi `/health` publik.
2. Daftarkan endpoint di dashboard Agent Games → ambil HMAC secret via
   **Rotate Secret** → isi ke env Vercel (`AGENT_GAMES_HMAC_SECRET`) →
   redeploy → verifikasi `/health` (`hmac_configured: true`).
3. Jalankan **Practice Mode**: kirim/semua 7 jenis trap + 1 valid —
   pastikan `decision` + `reason_code` benar dan response terverifikasi
   tanda tangannya.
4. Konfirmasi 2 asumsi implementasi ini di practice (lihat § Asumsi):
   header HMAC masuk + format `sha256=<hex>`.
5. Baru ikut ronde scored berikutnya (mulai ronde 3, 15 Nov 17:30 WIB).
   Jangan ubah kode/secret di tengah ronde yang sedang terbuka.

## Proof (v2 — aktif bila `PROOF_ENABLED=true`)

**v2 menjawab decision + proof Groth16 lokal.** Setiap keputusan yang
dapat dibuktikan (semua kecuali `PROOF_REUSED`) digenerate proof-nya
dengan `snarkjs` + circuit resmi (`circuits/gatekeeper.wasm` +
`circuits/gatekeeper_final.zkey`), diverifikasi ulang secara lokal,
lalu dikembalikan di response yang ditandatangani:

```json
{"decision": "APPROVE", "reason_code": "VALID_CONDITION", "proof_tx": "0xa4c1...8ff1", "proof": {"pi_a": [...], "pi_b": [[...]], "pi_c": [...], "protocol": "groth16", "curve": "bn128"}, "public_signals": ["...", "..."]}
```

Tanpa Kurier / submit on-chain: platform memverifikasi ulang proof
terhadap key terdaftarnya sendiri (offline verification). Buktinya:
tiga agent live independen dengan receipt "proof VERIFIED" di Practice
Mode memakai format persis ini — lince00/agent-games-gatekeeper,
hitokarumashaki/agent-games ("the platform accepts proof plus public
signals alone, no on-chain submission needed"), District-X/
agent-games-zkverify — dan guide /build §02.5: "generate proofs
locally with snarkjs, and include the proof in your response."

Skor: keputusan benar + proof valid = +12 dan dihitung untuk bonus
reliabilitas +0..+5; tanpa proof valid = +10 (−2 ekstra, tanpa bonus).
Proof yang gagal (input buruk, keputusan salah — circuit menolak
membangun witness untuk keputusan salah — timeout, artifacts hilang)
tidak pernah memalsukan proof: handler menjawab decision-only (−2,
sama seperti v1) dan tidak pernah crash / melewati deadline. Budget
proof 45 detik, dan dibatasi juga oleh `deadline_at − 5 detik`.

Circuit (Groth16/BN128, Circom 2.x) dari
`https://agentgames.zkverify.io/api/circuit-info` (dicek 14 Nov 2026,
artifacts diunduh + diverifikasi 19 Nov 2026):
  - Gatekeeper `vkHash`:
    `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`
  - WASM: `https://agentgames.zkverify.io/circuits/gatekeeper.wasm`
    (1.755.820 bytes, sha256 be00aefe…)
  - zkey: `https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey`
    (309.750 bytes, sha256 adfe95a4…)
  - 13 input: `registeredVkHash, proofVkHash, minimum, publicBalance,
    expiryBlock, currentBlock, recipient, conditionRecipient, amount,
    maxTransfer, decision, taskId, salt` (privat, acak per proof).
    Public signals (13, output-then-public): `[komitmen Poseidon,
    registeredVkHash, …, decision, taskId]` — taskId TERAKHIR.
  - Encoding (terverifikasi numerik terhadap public signals yang
    dipublikasi @dyors): hash VK = BigInt(0x-hex) mod p; taskId =
    keccak256(UTF-8) mod p; alamat = BigInt(0x-hex) biasa.
    **Caveat jujur:** platform tidak pernah mempublikasikan encoding
    taskId; tiga repo publik memakai tiga encoding berbeda (keccak256 /
    SHA-256 / byte UTF-8 mentah). keccak256 dipakai di sini karena
    dukungannya terkuat (2 dari 3 repo + reproduksi eksak sinyal publik
    yang dipublikasi). Praktik menandai VERIFIED untuk ketiganya, jadi
    praktik tidak bisa membedakan — dan skenario terburuk bila encoding
    salah adalah hasil v1 (−2, tanpa bonus), tidak pernah lebih buruk.
- `PROOF_REUSED` tidak membawa proof: aturan skor mengecualikannya,
  dan circuit tidak bisa membuktikan REJECT atas kondisi yang
  sebenarnya valid.

## Asumsi yang harus dikonfirmasi di Practice Mode

1. **Header HMAC masuk = `x-agent-games-signature`, format
   `sha256=<hex>`.** Situs hanya menulis "verify the HMAC signature
   against the raw body" dan "every response is signed with
   `x-agent-games-signature`". Nama header response sudah pasti (dari
   guide §04); nama/format header *masuk* diasumsikan sama. Server ini
   menerima `sha256=<hex>` atau hex polos. Kalau practice gagal 401,
   cek header sebenarnya di dashboard/dok, ubah hanya `hmac.js`.
2. **Seen-set = semua `proof_tx` yang diproses** (bukan hanya yang
   APPROVE). Halaman event menulis PROOF_REUSED sebagai proof yang
   "already accepted". Implementasi ini sengaja lebih ketat (fail-closed).
   Kalau practice menunjukkan proof yang di-REJECT dikirim ulang secara
   sah, persempit ke APPROVE-only.
3. **Response = 3 field keputusan + `proof` + `public_signals` bila
   `PROOF_ENABLED=true`** (kecuali `PROOF_REUSED`: tanpa proof).
   Format ini dikonfirmasi tiga agent live dengan receipt VERIFIED di
   Practice Mode (lihat § Proof). Contoh di halaman event hanya
   menampilkan 3 field keputusan karena field proof bersifat tambahan.

## Hasil test (14 Nov 2026, Node v24.22.1)

```
npm test — 18 pass, 0 fail
✔ 1 VALID_CONDITION APPROVE
✔ 2 VK_SUBSTITUTION, 3 THRESHOLD_MISMATCH, 4 PROOF_REUSED,
  5 EXPIRED_CONDITION, 6 RECIPIENT_MISMATCH, 7 AMOUNT_OVERFLOW
✔ precedence: reused + bad VK -> PROOF_REUSED
✔ boundary: balance==minimum, amount==max, current==expiry -> APPROVE
✔ boundary: recipient case-insensitive, BigInt di atas 2^53
✔ malformed: missing input / VK / unparseable balance -> REJECT fail-closed
✔ hmac: round-trip ok, tampered body / wrong secret / missing sig gagal
✔ proof: stub melempar, tidak pernah memalsukan proof
✔ seen: persist JSON + reload setelah "restart"
✔ http: /health ok; /task 401 tanpa/salah signature; 200 + response
  terverifikasi + replay -> PROOF_REUSED
```

Smoke test live (server lokal, mode unsigned): task valid → APPROVE
`VALID_CONDITION` (1 ms); replay `proof_tx` sama → REJECT `PROOF_REUSED`.

Simulasi entry Vercel lokal (15 Nov 2026, `vercel-smoke-test.js` — bukan
bagian repo): GET /health → 200 `status: ok`, POST /task unsigned → 401,
signed valid → APPROVE `VALID_CONDITION` + response terverifikasi,
replay → REJECT `PROOF_REUSED`. Semua PASS.

## Yang TIDAK dilakukan di sini

- Repo sudah di GitHub (0xepep/persilit-gatekeeper) dan agent `persilit`
  sudah terdaftar di dashboard Agent Games (15 Nov 2026). Belum deploy
  ke hosting, belum daftar endpoint, belum kirim proof on-chain, belum
  pakai dana/secret apa pun — deploy + secret platform masih butuh
  langkah di bawah (lihat § Deploy + Checklist preflight).
