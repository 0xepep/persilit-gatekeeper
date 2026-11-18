# Deploy Gatekeeper — langkah demi langkah

Status kode: siap deploy. Server terverifikasi lokal (18/18 test PASS, smoke
test: unsigned -> 401, signed valid -> APPROVE, replay -> PROOF_REUSED;
simulasi entry Vercel lokal juga PASS, lihat README).
Repo: https://github.com/0xepep/persilit-gatekeeper (publik).
Agent `persilit` sudah terdaftar di dashboard Agent Games (15 Nov 2026),
endpoint masih kosong.

## Pilihan hosting: Vercel (dipilih 15 Nov 2026)

Render awalnya dipilih, tapi **mentok 15 Nov 2026 ~04:31 WIB: Render
wajibkan kartu kredit untuk verifikasi identitas** (otorisasi sementara
$1, menurut Render tidak ditagih) bahkan untuk Free tier — muncul saat
klik "Deploy web service". Akun Render sudah dibuat + terverifikasi
email, form Web Service sudah terisi, tapi tidak ada kartu yang
dimasukkan. Vercel Hobby gratis dan **tidak minta kartu**. Fly.io juga
butuh kartu. Kalau suatu saat mau pindah ke Render, `render.yaml` masih
ada di repo.

## Yang masih butuh user (tidak bisa dikerjakan dari VM ini)

1. **HMAC secret** — hanya muncul setelah agent didaftarkan di dashboard
   Agent Games (Manage agents -> agent `persilit` -> Rotate Secret).
   Secret ini TIDAK BOLEH ditebak atau di-hardcode.
2. **Endpoint di dashboard Agent Games** — isi URL Vercel setelah deploy
   (dari HP, karena dashboard login pakai X @juvenzad yang kena limit IP
   dari VM ini).

## Langkah deploy (Vercel)

1. Vercel (https://vercel.com) -> sign in dengan GitHub 0xepep ->
   Add New -> Project -> Import `0xepep/persilit-gatekeeper`.
   Framework Preset: Other. Build Command: kosong (tanpa dependensi).
   Root Directory: repo root.
2. Environment Variables (sebelum Deploy):
   `SEEN_FILE` = `/tmp/seen.json`,
   `ALLOW_UNSIGNED_TASKS` = `false`,
   `PROOF_ENABLED` = `false`.
   `AGENT_GAMES_HMAC_SECRET` BELUM diisi (belum ada secretnya).
3. Deploy -> tunggu status `Ready`, lalu cek dari browser:
   `https://persilit-gatekeeper.vercel.app/health`
   harus `{"status":"ok",...,"hmac_configured":false,...}`.
   (`hmac_configured: false` normal sebelum secret diisi.)
4. Di dashboard Agent Games (Manage agents -> agent `persilit`) ->
   isi endpoint `https://persilit-gatekeeper.vercel.app` (atau
   `/task` bila dashboard minta URL task lengkap — cek placeholder
   formnya) -> Rotate Secret -> salin secretnya.
5. Di Vercel project -> Settings -> Environment Variables -> tambah
   `AGENT_GAMES_HMAC_SECRET` = nilai Rotate Secret -> Redeploy.
   Verifikasi ulang `/health`: `hmac_configured` harus `true`.
6. Jalankan **Practice Mode** dari dashboard: kirim 1 valid + 7 trap,
   pastikan decision + reason_code benar dan response terverifikasi.
7. Baru ikut ronde scored berikutnya (ronde 3: 15 Nov 17:30 WIB).
   Jangan ubah kode/secret di tengah ronde yang sedang terbuka.

## Batasan yang harus diketahui sebelum ronde

- **Seen-set per instance di Vercel.** `SEEN_FILE=/tmp/seen.json`
  hanya hidup di dalam satu function instance; instance dingin mulai
  dengan seen-set kosong, jadi proof yang sudah dipakai bisa lolos lagi
  sebagai baru kalau task-nya jatuh ke instance lain. Mitigasi: jangan
  redeploy di tengah ronde; v1.1 pindahkan seen-set ke KV/Redis gratis.
- **v2 proof-backed (19 Nov 2026): local Groth16 proofs via snarkjs.**
  Tiap jawaban benar + proof valid = +12 dan dihitung untuk bonus
  reliabilitas +0..+5 (sebelumnya decision-only: −2 per jawaban benar).
  Aktif bila env `PROOF_ENABLED=true` (sudah `true` di Vercel).
  Detail + caveat encoding taskId di `proof.js` / README § Proof.
- **Jangan set `ALLOW_UNSIGNED_TASKS=true` di endpoint publik.**
