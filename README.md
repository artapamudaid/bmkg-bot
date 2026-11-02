# BMKG Kediri Bot

Telegram bot cuaca lokal berbasis Bun, ElysiaJS, dan TypeScript. Bot mengambil alert BMKG untuk lokasi aktif pengguna, menjawab pertanyaan dengan Gemini atau provider OpenAI-compatible, menyediakan info gempa terkini, dan dapat mengirim notifikasi alert Kediri terjadwal.

## Fitur utama

- Menerima lokasi Telegram dan mengubah koordinat menjadi nama kota/kabupaten melalui OpenStreetMap Nominatim.
- Menyimpan lokasi pengguna di SQLite (`data.sqlite`) menggunakan `bun:sqlite`.
- Mengambil alert nowcast dan prakiraan cuaca BMKG per 3 jam berdasarkan desa/kelurahan.
- Menjawab pertanyaan cuaca dengan Gemini atau API OpenAI-compatible (misalnya Sumopod dan OpenRouter).
- Mengirim informasi gempa terkini dari BMKG.
- Mengirim alert baru untuk Kediri ke chat notifikasi dengan cron.
- Memetakan lokasi GPS sampai desa/kelurahan (kode ADM4), menyimpan kode tersebut, lalu mengambil prakiraan BMKG hari ini per 3 jam.
- Menampilkan indikator “sedang mengetik” saat memproses permintaan yang memerlukan waktu.
- Mendaftarkan command Telegram ke menu bot saat aplikasi mulai.
- Menyediakan endpoint HTTP `/` dan `/health` melalui Elysia.

## Persyaratan

- Bun versi 1.4 atau lebih baru.
- Token bot Telegram dari [@BotFather](https://t.me/BotFather).
- Salah satu konfigurasi AI:
  - Gemini API key; atau
  - API key, base URL, dan model untuk provider OpenAI-compatible.
- `TELEGRAM_NOTIF_CHAT_ID` untuk mengaktifkan notifier cron. Pastikan bot dapat mengirim pesan ke chat tersebut.
- Saat lokasi dibagikan, reverse geocoding OpenStreetMap Nominatim dan direktori wilayah `wilayah.id` digunakan untuk menentukan kode ADM4 yang dibutuhkan API prakiraan BMKG.

## Instalasi lokal

Clone repository, lalu pasang dependency:

```bash
git clone <URL_REPOSITORY> bmkg-bot
cd bmkg-bot
bun install
```

Salin template environment dan isi nilainya:

```bash
cp .env.example .env
nano .env
```

Jangan commit `.env` atau membagikan token/API key. File `.env` sudah termasuk dalam `.gitignore`.

### Konfigurasi environment

Atur environment sesuai provider AI yang dipilih. `TELEGRAM_BOT_TOKEN` dan `TELEGRAM_NOTIF_CHAT_ID` wajib untuk menjalankan aplikasi saat ini; token AI wajib sesuai provider yang dipilih.

| Variabel | Wajib | Keterangan |
|---|---|---|
| `PORT` | Tidak | Port HTTP Elysia. Default `3000`; ubah jika port tersebut sudah dipakai. |
| `TELEGRAM_BOT_TOKEN` | Ya | Token bot dari BotFather. |
| `TELEGRAM_NOTIF_CHAT_ID` | Ya | ID chat/grup/channel tujuan broadcast alert Kediri. Pastikan bot dapat mengirim pesan ke tujuan tersebut. |
| `AI_PROVIDER` | Tidak | Provider AI: `gemini` (default) atau `openai-compatible`. |
| `GEMINI_API_KEY` | Jika Gemini dipilih | API key Google Gemini. Model yang digunakan `gemini-2.5-flash`. |
| `OPENAI_COMPATIBLE_BASE_URL` | Jika OpenAI-compatible dipilih | Base URL API, misalnya `https://api.provider.example/v1`. Aplikasi menambahkan `/chat/completions`. |
| `OPENAI_COMPATIBLE_API_KEY` | Jika OpenAI-compatible dipilih | API key dari provider. |
| `OPENAI_COMPATIBLE_MODEL` | Jika OpenAI-compatible dipilih | ID model yang didukung provider. |
| `CRON_SCHEDULE` | Tidak | Ekspresi cron notifier. Default `*/10 * * * *` (setiap 10 menit). |

Contoh memakai Gemini:

```dotenv
PORT=3000
TELEGRAM_BOT_TOKEN=123456:token-dari-botfather
TELEGRAM_NOTIF_CHAT_ID=-1001234567890
AI_PROVIDER=gemini
GEMINI_API_KEY=api-key-gemini
CRON_SCHEDULE=*/10 * * * *
```

Contoh memakai API OpenAI-compatible:

```dotenv
PORT=3000
TELEGRAM_BOT_TOKEN=123456:token-dari-botfather
TELEGRAM_NOTIF_CHAT_ID=-1001234567890
AI_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_BASE_URL=https://api.provider.example/v1
OPENAI_COMPATIBLE_API_KEY=api-key-provider
OPENAI_COMPATIBLE_MODEL=nama-model-provider
CRON_SCHEDULE=*/10 * * * *
```

Nilai URL dan model di contoh hanya placeholder. Gunakan base URL dan ID model persis dari dokumentasi provider yang dipilih. Saat menggunakan OpenAI-compatible, `GEMINI_API_KEY` tidak diperlukan. `TELEGRAM_NOTIF_CHAT_ID` perlu diisi karena aplikasi menginisialisasi notifier saat startup.

Setelah menyimpan `.env`, pastikan file tidak masuk ke Git:

```bash
git check-ignore .env
```

## Menjalankan dan memeriksa

Mode pengembangan dengan restart saat kode berubah:

```bash
bun run dev
```

Mode normal:

```bash
bun run start
```

Pemeriksaan TypeScript:

```bash
bun run typecheck
```

## Perintah Telegram

- `/start` atau `/help` — tampilkan bantuan dan keyboard interaktif.
- `/cuaca` — prakiraan BMKG hari ini per 3 jam untuk lokasi aktif. Tambahkan nama kecamatan dan kabupaten untuk lokasi lain, misalnya `/cuaca Ngadiluwih kab. Kediri`.
- `/gempa` — informasi gempa terkini yang dirasakan.
- `/alert` — periksa alert dini BMKG untuk wilayah aktif. Tidak adanya alert bukan berarti tidak ada hujan.
- `/lokasi` — lihat lokasi aktif dan cara memperbaruinya dengan GPS.
- Pesan teks biasa — ajukan pertanyaan cuaca kepada asisten AI dengan konteks prakiraan dan alert. Jika pertanyaan menyebut kecamatan (contoh: “cuaca daerah Ngadiluwih kab. Kediri”), bot mencari wilayah itu dan memakai agregasi prakiraan BMKG desa-desa di kecamatan tersebut, bukan lokasi GPS yang tersimpan.

Daftar command didaftarkan ke menu Telegram default dan bahasa Indonesia saat aplikasi mulai. Jika menu lama masih terlihat, pastikan proses terbaru berhasil start dan periksa log pendaftaran; lalu tutup/buka kembali chat bot atau ketik `/` untuk memuat ulang daftar.

Untuk prakiraan yang tepat, pengguna perlu mengirim lokasi menggunakan tombol **📍 Bagikan Lokasi Saya**. Bot memetakan titik GPS sampai ADM4 menggunakan Nominatim dan `wilayah.id`; prakiraan BMKG resmi memerlukan kode desa/kelurahan. Pengguna lama yang belum memiliki ADM4 perlu membagikan lokasi kembali. Jika GPS tidak dapat dipetakan, bot menampilkan error dan tidak membuat kode wilayah berdasarkan tebakan.

Server monitoring tersedia di:

- `http://localhost:3000/` — nama aplikasi dan status.
- `http://localhost:3000/health` — status health dan waktu pemeriksaan.

Ganti port pada URL jika `PORT` diatur ke nilai lain. Database `data.sqlite` dibuat otomatis di working directory aplikasi pada penggunaan pertama. Berkas database dan berkas SQLite terkait diabaikan Git melalui `.gitignore`; data lokal tidak ikut tersimpan di repository. Buat backup database secara terpisah jika perlu mempertahankan data pengguna saat memindahkan server atau melakukan pemulihan.

Skema pengguna lama dimigrasikan otomatis dengan menambahkan kolom kode ADM4. Pengguna lama perlu membagikan lokasi GPS sekali lagi agar kode itu tersimpan dan prakiraan harian dapat diambil.

## Menjalankan 24/7 di Ubuntu VPS dengan PM2

### 1. Pasang Bun dan PM2

Jalankan sebagai user Linux biasa yang akan menjalankan bot, bukan sebagai `root`:

```bash
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
bun --version
command -v bun

sudo npm install -g pm2
pm2 --version
```

Pastikan Node.js/npm tersedia untuk memasang PM2.

### 2. Siapkan proyek di lokasi tetap

```bash
cd /home/ubuntu
git clone <URL_REPOSITORY> bmkg-bot
cd /home/ubuntu/bmkg-bot

bun install
cp .env.example .env
nano .env
chmod 600 .env
bun run typecheck
```

Isi `.env` sesuai bagian [Konfigurasi environment](#konfigurasi-environment). Pastikan `TELEGRAM_NOTIF_CHAT_ID` valid agar notifier dapat dimulai.

### 3. Konfigurasi PM2 ecosystem

File `ecosystem.config.cjs` sudah tersedia di root repository. File ini menjalankan executable Bun secara langsung dengan argumen `run src/index.ts` (tanpa wrapper interpreter Bun PM2), memakai direktori proyek sebagai `cwd`, dan mengaktifkan restart otomatis jika proses berhenti. Nama proses PM2 yang didaftarkan file ini adalah `bmkg-bot`.

Secara default konfigurasi mengharapkan Bun pada `~/.bun/bin/bun`. Jika `command -v bun` menunjukkan lokasi berbeda, jalankan PM2 dengan `BUN_BIN`:

```bash
cd /home/ubuntu/bmkg-bot
BUN_BIN="$(command -v bun)" pm2 start ecosystem.config.cjs
```

Jika Bun berada di path default:

```bash
pm2 start ecosystem.config.cjs
```

Periksa status dan log:

```bash
pm2 status
pm2 logs bmkg-bot
```

### 4. Aktifkan start otomatis setelah reboot

Daftarkan PM2 sebagai service systemd untuk user aplikasi:

```bash
pm2 startup systemd -u ubuntu --hp /home/ubuntu
```

PM2 akan mencetak perintah lanjutan yang biasanya diawali `sudo env ...`. Salin dan jalankan perintah yang dicetak persis, lalu simpan daftar proses:

```bash
pm2 save
```

PM2 akan memulihkan proses yang disimpan setelah reboot dan me-restart bot jika proses mengalami exit. Untuk memverifikasi, reboot VPS saat waktu pemeliharaan lalu jalankan `pm2 status`.

Perintah operasional:

```bash
pm2 restart bmkg-bot
pm2 stop bmkg-bot
pm2 logs bmkg-bot
pm2 status
```

Setelah deploy versi baru, dari direktori proyek:

```bash
git pull
bun install
bun run typecheck
pm2 restart bmkg-bot --update-env
pm2 save
```

Jika mengubah konfigurasi atau path Bun di `ecosystem.config.cjs`, jalankan ulang konfigurasi ecosystem:

```bash
BUN_BIN="$(command -v bun)" pm2 startOrRestart ecosystem.config.cjs --update-env
pm2 save
```

## Struktur sumber

```text
src/
├── index.ts                 # Telegram handlers dan server Elysia
├── config.ts                # Environment dan konfigurasi runtime
├── db.ts                    # SQLite dan lokasi pengguna
├── services/
│   ├── ai.ts                # Gemini/OpenAI-compatible
│   ├── bmkg.ts              # Alert dan info gempa BMKG
│   └── geocoding.ts         # Reverse geocoding Nominatim
└── cron/
    └── notifier.ts          # Notifikasi alert Kediri terjadwal
```
