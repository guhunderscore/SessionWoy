# Glosarium SessionWoy

Daftar singkatan dan istilah yang dipakai di PRD, ADR, kode, dan diskusi proyek SessionWoy.
Urutan per kelompok mengikuti topik, bukan abjad.

## 1. Dokumen dan proses

| Istilah | Kepanjangan | Arti di proyek ini |
| --- | --- | --- |
| **PRD** | Product Requirements Document | Spesifikasi lengkap produk: tujuan, kebutuhan, arsitektur, rencana fase. File: `docs/adr/SessionWoy — PRD.md` |
| **ADR** | Architecture Decision Record | Dokumen pendek yang mencatat satu keputusan teknis, alasannya, dan konsekuensinya. Disimpan di `docs/adr/` |
| **ADR 0001** | — | `docs/adr/0001-cookie-swapping.md`. Keputusan memakai *cookie swapping* dan kriteria lulus/gagal (G1–G10) yang ditetapkan **sebelum** kode ditulis |
| **ADR 0002** | — | `docs/adr/0002-poc-result.md`. Hasil POC: tabel tes, temuan F1–F6, batasan yang diketahui, matriks kompatibilitas, dan verdict |
| **POC** | Proof of Concept | Versi minimal untuk membuktikan bahwa ide yang berisiko benar-benar bisa jalan, sebelum membangun produk lengkap. Di sini: apakah cookie bisa dipisah per tab |
| **MVP** | Minimum Viable Product | Versi terkecil produk yang sudah benar-benar bisa dipakai (definisinya ada di PRD §15) |
| **Phase 0–6** | — | Tahapan pengerjaan di PRD §11: 0 riset, 1 test server, 2 POC, 3 UI, 4 persistensi & backend, 5 kompatibilitas, 6 fitur tambahan |
| **Go / No-go gate** | — | Titik keputusan setelah POC: lanjut (GO) atau beralih ke rencana cadangan (NO-GO, PRD §14.1) |
| **Provisional GO** | — | "Lanjut dengan syarat": tes otomatis lolos, tetapi pengecekan manual belum selesai. Status Phase 2 sebelum 2026-11-10 |
| **GO** | — | Semua syarat terpenuhi. Status Phase 2 sejak 2026-11-10 |
| **Fallback** | — | Rencana cadangan bila POC gagal: Chrome dalam Docker atau profil Chrome terpisah (PRD §14.1) |
| **Compatibility matrix** | Matriks kompatibilitas | Tabel hasil uji SessionWoy di website nyata (ada di ADR 0002) |

## 2. Kode penomoran

| Kode | Arti | Lokasi |
| --- | --- | --- |
| **G-n** (G1–G10) | Kriteria go/no-go | ADR 0001 |
| **S-n** (S1–S15) | Skenario tes end-to-end; satu-satu cocok dengan tabel hasil | `e2e/tests/poc.spec.ts`, ADR 0002 |
| **F-n** (F1–F6) | Temuan teknis selama POC (misalnya F3 = race redirect, F6 = bug pewarisan sesi) | ADR 0002 |
| **FR-n** | *Functional Requirement*, kebutuhan fungsional | PRD §5 |
| **NFR** | *Non-Functional Requirement*, target kualitas (kecepatan, keamanan, keandalan) | PRD §6 |
| **G1, G2, …** dalam PRD | *Goal*, tujuan produk | PRD §2.1 (berbeda dari G-n di ADR 0001) |

## 3. Istilah khusus SessionWoy

| Istilah | Arti |
| --- | --- |
| **Sesi (session)** | Satu set cookie bernama (misalnya *Customer*) yang dipakai oleh satu atau beberapa tab |
| **Managed tab** | Tab yang sudah ditetapkan ke sebuah sesi. Cookie-nya diatur oleh SessionWoy |
| **Unmanaged tab** | Tab biasa tanpa sesi. Berperilaku persis seperti Chrome normal |
| **Shared jar** | *Cookie jar* bawaan Chrome yang dipakai bersama oleh semua tab biasa. Tab dengan sesi tidak pernah membaca atau menulis ke sini |
| **Session jar** | *Cookie jar* milik satu sesi, disimpan oleh extension |
| **Cookie swapping** | Teknik inti SessionWoy: mengganti header `Cookie` di setiap request dengan cookie milik sesi tab tersebut |
| **Presets (A/B/C)** | Sesi tetap di POC: A = Customer, B = Provider, C = Admin. Diganti sesi buatan pengguna di Phase 3 |
| **Inheritance (pewarisan sesi)** | Tab baru yang dibuka dari link di tab bersesi otomatis ikut sesi tab sumbernya (default: aktif) |
| **Stale request** | Request yang terkirim dengan cookie lama, karena aturan cookie belum sempat diperbarui (temuan F3) |
| **Heal** | Mekanisme yang memuat ulang navigasi GET yang terkirim dengan cookie lama, supaya halaman memakai cookie terbaru |
| **Race redirect** | Kondisi saat server mengirim `Set-Cookie` pada redirect `302`, lalu Chrome langsung mengikuti redirect sebelum aturan cookie diperbarui |
| **Snapshot cache** | Salinan cookie sesi (yang boleh dibaca JavaScript) di `sessionStorage`, supaya `document.cookie` langsung punya jawaban saat halaman di-reload |
| **Debug API** | Fungsi khusus pengujian di service worker (`globalThis.sessionwoy`). Harus dihapus atau dibatasi sebelum rilis |

## 4. Web dan browser

| Istilah | Kepanjangan | Arti |
| --- | --- | --- |
| **SPA** | Single-Page Application | Website yang dimuat sekali, lalu berpindah "halaman" lewat JavaScript tanpa reload penuh. Contoh: Gmail, saucedemo.com |
| **PWA** | Progressive Web App | Website yang bisa di-"install" seperti aplikasi; hampir selalu memakai Service Worker |
| **Cookie** | — | Data kecil dari website yang disimpan browser dan dikirim kembali di setiap request (misalnya status login) |
| **Cookie jar** | — | "Toples" tempat browser menyimpan cookie. Chrome biasanya hanya punya satu per profil |
| **Set-Cookie** | — | Header dari server yang menyuruh browser menyimpan cookie, misalnya setelah login |
| **`document.cookie`** | — | Cara JavaScript di halaman membaca dan menulis cookie |
| **HttpOnly** | — | Cookie yang tidak bisa dibaca JavaScript, hanya dikirim ke server. Biasanya cookie login |
| **Secure** | — | Cookie yang hanya dikirim lewat HTTPS |
| **SameSite** | — | Aturan kapan cookie boleh ikut terkirim dari situs lain: `Strict`, `Lax`, atau `None` |
| **Max-Age / Expires** | — | Masa berlaku cookie. `Max-Age=0` berarti cookie dihapus |
| **localStorage / sessionStorage** | — | Penyimpanan data di browser selain cookie. **Tidak** dipisah per sesi oleh SessionWoy (batasan no. 4) |
| **IndexedDB / CacheStorage** | — | Penyimpanan browser lain yang lebih besar. Juga tidak dipisah per sesi |
| **Origin** | — | Kombinasi skema + host + port, misalnya `http://localhost:3000` |
| **Redirect / 302** | — | Respons server yang menyuruh browser pindah ke URL lain |
| **CSRF** | Cross-Site Request Forgery | Serangan yang memalsukan request dari situs lain. Aplikasi Rails melindunginya dengan token CSRF |
| **OAuth** | — | Login lewat pihak ketiga ("Login dengan Google"), biasanya lewat popup atau redirect |
| **CHIPS** | Cookies Having Independent Partitioned State | Cookie yang dipisah per situs induk. Belum didukung di POC |
| **PSL** | Public Suffix List | Daftar domain publik (seperti `.co.id`) agar cookie tidak dipasang untuk seluruh domain publik. Belum dipakai di POC |
| **Loopback (127.0.0.1)** | — | Alamat yang hanya bisa diakses dari komputer sendiri, tidak dari jaringan |

## 5. Chrome Extension

| Istilah | Kepanjangan | Arti |
| --- | --- | --- |
| **MV3** | Manifest Version 3 | Format extension Chrome yang berlaku sekarang. Aturannya lebih ketat; extension tidak bisa lagi menahan request secara langsung |
| **Manifest** | — | File `manifest.json` yang mendeskripsikan extension: nama, izin, icon, script |
| **DNR** | declarativeNetRequest | API Chrome untuk mengubah request lewat aturan yang didaftarkan ke browser. Dipakai untuk mengganti header `Cookie` per tab |
| **Session rules** | — | Aturan DNR yang hidup selama browser berjalan (hilang saat browser di-restart) |
| **webRequest** | — | API Chrome untuk *mengamati* request dan respons. Dipakai untuk membaca `Set-Cookie` |
| **Service Worker (SW)** | — | Skrip yang berjalan di latar belakang. Ada dua jenis: (1) milik **extension**, yaitu otak SessionWoy; (2) milik **website**, yang request-nya tidak terikat ke tab sehingga belum bisa dipisah per sesi (batasan no. 1) |
| **Content script** | — | Skrip extension yang disisipkan ke halaman web |
| **MAIN world / ISOLATED world** | — | MAIN = konteks JavaScript milik halaman; ISOLATED = konteks terpisah milik extension. SessionWoy memakai keduanya untuk `document.cookie` |
| **Popup** | — | Jendela kecil yang muncul saat ikon extension diklik |
| **Badge** | — | Teks kecil berwarna di atas ikon extension (misalnya nama sesi) |
| **Host permission** | — | Izin extension untuk mengakses situs tertentu. Diberikan per situs lewat tombol *Grant access to this site* |
| **`chrome.storage.session`** | — | Penyimpanan extension di memori; hilang saat extension di-reload atau browser di-restart (batasan no. 8) |
| **Unpacked extension** | — | Extension yang dimuat langsung dari folder (`extension/dist`) lewat *Developer mode*, bukan dari Chrome Web Store |

## 6. Tooling dan infrastruktur

| Istilah | Kepanjangan | Arti |
| --- | --- | --- |
| **E2E** | End-to-End test | Tes yang menjalankan browser sungguhan beserta extension-nya, dari awal sampai akhir (folder `e2e/`) |
| **Unit test** | — | Tes kecil untuk satu fungsi atau modul, tanpa browser (Vitest) |
| **Playwright** | — | Alat otomasi browser untuk tes E2E |
| **Vitest** | — | Framework unit test untuk TypeScript |
| **esbuild** | — | Alat build yang menggabungkan kode TypeScript extension ke folder `dist/` |
| **Fastify** | — | Framework web Node.js untuk test server dan backend |
| **Docker / Docker Compose** | — | Menjalankan layanan dalam container. Service `app` = test server (port 3003), `backend` = API Phase 4 (port 3004) |
| **CDP** | Chrome DevTools Protocol | Jalur kontrol Chrome yang dipakai tes otomatis, misalnya untuk mematikan service worker (S10) |
| **npm workspaces** | — | Satu repo berisi beberapa paket: `extension`, `test-server`, `e2e` |
| **SQLite** | — | Database berbasis file, direncanakan untuk backend Phase 4 |

## 7. Keamanan dan pengukuran

| Istilah | Kepanjangan | Arti |
| --- | --- | --- |
| **AES-256-GCM** | Advanced Encryption Standard, 256-bit, Galois/Counter Mode | Algoritma enkripsi yang direncanakan untuk menyimpan cookie dengan aman (Phase 4) |
| **PBKDF2** | Password-Based Key Derivation Function 2 | Cara membuat kunci enkripsi dari passphrase pengguna |
| **Ciphertext** | — | Data yang sudah terenkripsi. Backend Phase 4 hanya menyimpan ciphertext |
| **p50 / p95** | Persentil ke-50 / ke-95 | p95 = 95% request lebih cepat dari angka ini. Dipakai untuk mengukur tambahan latensi (S14) |
| **Latency** | — | Waktu tunda sebuah request |
| **Stress test** | — | Tes beban dengan sangat banyak request sekaligus (S2: 10.000 request per tab) |
