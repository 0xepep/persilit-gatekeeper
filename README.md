# Proof Gatekeeper — zkVerify Agent Games (v1, decision-only)

Agent untuk track **Proof Gatekeeper** di [Agent Games](https://agentgames.zkverify.io)
(cek sumber: 14 Nov 2026). Menjawab task approve/reject pembayaran berbasis
ZK proof. **v1 ini decision-only: logika keputusan lengkap, proof Groth16
BELUM aktif** (lihat § Proof di bawah).

## Status kompetisi (terverifikasi 14 Nov 2026)

- Hadiah track ini: 100.000 VFY (1st 50.000 / 2nd 30.000 / 3rd 20.000).
  Total pool semua track 400.000 VFY. Entry gratis, semua track tutup 21 Nov 2026.
- Ronde: 8 ronde harian, 8 task/agent/hari, skor kumulatif.
  Ronde 1 (13 Nov) sudah lewat. Ronde 2 (14 Nov) sedang live saat repo ini
  dibuat. **Target realistis: ronde 3–8, 15–20 Nov 2026.**
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
| `server.js` | HTTP server zero-dependency: `POST /task`, `GET /health`, `GET /` |
| `decision.js` | Logika murni (tanpa I/O) — mudah dites |
| `hmac.js` | HMAC-SHA256 sign/verify (`sha256=<hex>`, timing-safe) |
| `seen.js` | Seen-set `proof_tx`: in-memory + persist ke JSON (atomic rename) |
| `proof.js` | **STUB proof Groth16 — sengaja belum aktif, `generateGatekeeperProof()` selalu throw** |
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
| `PROOF_ENABLED` | Tidak | `false` di v1. Lihat § Proof |

**Tanpa secret:** `POST /task` menjawab 401 (`hmac_not_configured`),
kecuali `ALLOW_UNSIGNED_TASKS=true`. Signature salah/hilang juga 401 —
tanpa keputusan apa pun.

## Deploy ke HTTPS gratis (dipilih: Render Free Tier)

Kenapa Render: free tier punya HTTPS otomatis + deploy dari Git + env vars
di dashboard + cukup untuk endpoint yang bangun saat ada request. Catatan:
free instance **sleep setelah idle** — request pertama setelah tidur bisa
lambat; mitigasi: biarkan platform mengirim health-check/practice, dan
jangan andalkan cold-start < 60 detik tanpa pemanasan. (Jika cold-start
jadi masalah di ronde, pindah ke Fly.io free tier — prosesnya mirip,
tapi butuh `flyctl` + kartu kredit untuk verifikasi akun.)

Langkah (BELUM dilakukan — jangan deploy sebelum checklist § Preflight):

1. Push repo ini ke GitHub (repo privat tidak masalah).
2. Di [dashboard.render.com](https://dashboard.render.com): New → Web Service
   → pilih repo → Runtime `Node`, Build Command kosong (tanpa dependensi),
   Start Command `node server.js`.
3. Instance Type: **Free**. Health Check Path: `/health`.
4. Environment → tambah:
   `AGENT_GAMES_HMAC_SECRET` = (nilai Rotate Secret dari Agent Games),
   `SEEN_FILE` = `/tmp/seen.json` atau path disk yang persisten.
   ⚠️ Free tier Render **tidak punya persistent disk**: `data/seen.json`
   hilang saat redeploy/restart. Itu risiko PROOF_REUSED terlewat setelah
   restart. Mitigasi untuk ronde: (a) jangan redeploy di tengah ronde,
   (b) untuk v1.1, pindahkan seen-set ke KV/Redis gratis atau simpan
   `seen.json` di repo privat yang di-commit ulang — keduanya belum
   diimplementasikan di v1 ini.
   Jangan set `ALLOW_UNSIGNED_TASKS=true` di Render.
5. Deploy → tunggu `Live` → cek `https://<nama>.onrender.com/health`
   harus `{"status":"ok",...}`.
6. Lanjut ke checklist preflight di bawah.

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

1. Deploy ke Render (di atas), verifikasi `/health` publik.
2. Register agent + endpoint di dashboard → ambil HMAC secret via
   **Rotate Secret** → isi ke env Render → redeploy → verifikasi
   `/health` (`hmac_configured: true`).
3. Jalankan **Practice Mode**: kirim/semua 7 jenis trap + 1 valid —
   pastikan `decision` + `reason_code` benar dan response terverifikasi
   tanda tangannya.
4. Konfirmasi 2 asumsi implementasi ini di practice (lihat § Asumsi):
   header HMAC masuk + format `sha256=<hex>`.
5. Baru ikut ronde scored berikutnya (mulai ronde 3, 15 Nov 17:30 WIB).
   Jangan ubah kode/secret di tengah ronde yang sedang terbuka.

## Proof (keterbatasan v1 — baca dulu)

**v1 menjawab decision-only, tanpa proof Groth16.** Konsekuensi skor:
setiap keputusan benar tanpa proof valid = −2 ekstra dan tanpa bonus
reliabilitas +0..+5. Keputusan tetap benar; skor per ronde lebih rendah
dari agent ber-proof. **Proof TIDAK dipalsukan** — platform memverifikasi
ulang setiap proof dengan key-nya sendiri, jadi proof palsu hanya merugikan.

Untuk v2 (belum dikerjakan — butuh Kurier API key + download artifacts):

- Circuit (Groth16/BN128, Circom 2.x) dari
  `https://agentgames.zkverify.io/api/circuit-info` (dicek 14 Nov 2026):
  - Gatekeeper `vkHash`:
    `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`
  - WASM: `https://agentgames.zkverify.io/circuits/gatekeeper.wasm`
  - zkey: `https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey`
- Generate proof lokal dengan `snarkjs` (`.zkey` + `.wasm`).
- Kurier (direkomendasikan guide): API key mainnet → daftarkan verification
  key sekali → submit proof dengan vkHash → poll sampai `Finalized` →
  baru kembalikan sebagai confirmed. Alternatif zkVerifyJS butuh akun
  Volta yang terisi dana — di luar scope build gratis ini.
- Public inputs / circuit inputs yang tepat harus dibaca dari artifacts +
  practice task — jangan ditebak.

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
3. **Response hanya 3 field** (`decision`, `reason_code`, `proof_tx`),
   sesuai contoh di halaman event. Jika platform mengharapkan field
   proof tambahan, itu bagian dari pekerjaan proof v2.

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

## Yang TIDAK dilakukan di sini

- Tidak deploy ke hosting mana pun, tidak daftar agent/endpoint, tidak
  kirim proof on-chain, tidak pakai dana/secret apa pun, tidak commit ke
  GitHub. Semua langkah itu butuh user + secret platform (lihat
  § Checklist preflight).
