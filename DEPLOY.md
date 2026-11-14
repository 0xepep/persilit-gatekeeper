# Deploy Gatekeeper — langkah demi langkah

Status kode: siap deploy. Server terverifikasi lokal (18/18 test PASS, smoke
test: unsigned -> 401, signed valid -> APPROVE, replay -> PROOF_REUSED).
File `render.yaml` sudah ada di repo ini, jadi Deploy ke Render tinggal
sambungkan repo — tidak perlu isi build/start command manual.

## Yang masih butuh user (tidak bisa dikerjakan dari VM ini)

1. **Repo GitHub** — buat repo publik/privat, nama bebas (saran:
   `persilit-gatekeeper`), push isi folder `gatekeeper/` ini. `gh` CLI ada
   di VM tapi belum login ke GitHub, jadi push harus dari akun 0xepep.
2. **Akun Render** — belum ada login Render yang tersimpan. Daftar/login di
   dashboard.render.com (gratis, tanpa kartu untuk Free tier).
3. **HMAC secret** — hanya muncul setelah agent didaftarkan di dashboard
   Agent Games (Manage agents -> Register agent -> Rotate Secret). Secret
   ini TIDAK BOLEH ditebak atau di-hardcode.

## Langkah deploy (setelah 1-3 siap)

1. Render dashboard -> New -> Blueprint -> pilih repo -> Apply.
   Render membuat Web Service `persilit-gatekeeper` (Free, Node,
   Start `node server.js`, Health Check `/health`) dari `render.yaml`.
2. Di service Render -> Environment -> isi `AGENT_GAMES_HMAC_SECRET`
   dengan nilai Rotate Secret -> Save (Render redeploy otomatis).
   Pastikan `ALLOW_UNSIGNED_TASKS=false` dan `PROOF_ENABLED=false`.
3. Tunggu status `Live`, lalu cek dari browser:
   `https://persilit-gatekeeper.onrender.com/health`
   harus `{"status":"ok",...,"hmac_configured":true,...}`.
4. Di dashboard Agent Games (Manage agents) -> daftarkan endpoint
   `https://persilit-gatekeeper.onrender.com/task` untuk Proof Gatekeeper.
5. Jalankan **Practice Mode** dari dashboard: kirim 1 valid + 7 trap,
   pastikan decision + reason_code benar dan response terverifikasi.
6. Baru ikut ronde scored berikutnya. Jangan ubah kode/secret di tengah
   ronde yang sedang terbuka.

## Batasan yang harus diketahui sebelum ronde

- **Render Free tidur saat idle.** Request pertama setelah tidur bisa
  lambat (cold start). Mitigasi: health check/practice menjelang ronde
  17:30 WIB agar instance bangun. Kalau cold-start bikin timeout di
  ronde, satu-satunya jalan adalah tier berbayar / host lain.
- **Seen-set hilang saat restart.** `SEEN_FILE=/tmp/seen.json` di free
  tier tidak persisten — setelah redeploy/restart, proof yang sudah
  dipakai bisa lolos lagi sebagai baru. Mitigasi: jangan redeploy di
  tengah ronde; v1.1 pindahkan seen-set ke KV/Redis gratis.
- **v1 decision-only, tanpa proof Groth16.** Tiap jawaban benar tanpa
  proof valid kena -2 ekstra + tanpa bonus reliabilitas +0..+5 (lihat
  README). Itu biaya yang sudah diketahui, bukan bug.
- **Jangan set `ALLOW_UNSIGNED_TASKS=true` di endpoint publik.**
