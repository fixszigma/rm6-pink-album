---
name: rm6-pink-album
description: >-
  Architecture, workflow, and operational guide for the RM6 Pink album web
  application (v1.026112026). Use this skill when configuring, running,
  extending, or troubleshooting the RM6 Pink album system (Notebook Card Reader
  & Mobile Web App photo upload to a shared Google Drive folder, InsightFace
  SCRFD-10G + ArcFace-R50 512-D face recognition, Gemini AI verification,
  Guest Avatar history, LINE in-app browser escape & LINE sharing, Admin
  Settings authentication, GitHub Codespaces deployment, QR Code sharing, and
  ZIP downloads).
---

# RM6 Pink Album (`v1.026112026`) — Architecture & Workflow Skill

Tailored event photo-sharing and AI face search system developed for **ธนาคารออมสินภาค 6 (`RM6 Pink Album`)**.

## 1. Core Functional Scope

1. **Attendee-First UI (`Noto Sans Thai`)**:
   - Opens on **`🔍 ค้นหารูป`** with large navigation tabs (`🔍 ค้นหารูป` / `📤 อัปโหลดรูป`) and a **Mobile / Desktop / Auto** display toggle (`#btnToggleViewMode`, persisted in `localStorage`).
   - **Selfie Search & Guest Avatar**: Native `capture="user"` fallback, large centered reference selfie preview (`104×104`), returning user **Guest Avatar** saved in `localStorage` (`rm6_guest_avatar_v1`) from both selfies and `บุคคลในงาน` cluster clicks (`ดูอีก N ภาพ` badge).
   - **LINE In-App Browser & Sharing**: QR URL appends `?openExternalBrowser=1`, banner detects `Line/` (`FBAN`/`FBAV`/`Instagram`) with shortcut button (`intent://` on Android, external open + copy link on iOS), and **💬 แชร์ LINE** uses Web Share API (files) with `social-plugins.line.me/lineit/share` fallback.
   - **No Photo Deletion**: `DELETE /api/photos/:id` returns `403` to prevent accidental or unauthorized photo deletion.
2. **AI Face Analysis & Search Engine**:
   - **InsightFace `buffalo_l` (512-D)**: `det_10g.onnx` (SCRFD-10G) + `w600k_r50.onnx` (ArcFace-R50) via persistent Python ONNX worker (`scripts/arcface_worker.py` + `lib/arcface-client.js`), with calibrated cosine similarity & clustering in `lib/face-engine.js`.
   - **`arcface_gemini` (Default in Settings)**: Combines InsightFace 512-D with Gemini Vision verification (`lib/gemini-face.js`) for borderline cases.
   - Search engine mode & sensitivity threshold (`thresholdSlider`) live inside **⚙️ ตั้งค่า**.
3. **Admin-Protected Settings & Branding**:
   - **⚙️ ตั้งค่า** requires Admin Login (`POST /api/auth/login`, default password `rm6admin` or `ADMIN_PASSWORD` env var, `x-admin-token` header).
   - Supports custom **Event Name** and **Event Logo** upload (`eventLogoDataUrl` shown in header).
4. **Google Drive Sync & GitHub Codespaces**:
   - Supports **Owner OAuth2 Refresh Token** (`/api/drive/oauth/start` supporting browser `?origin=` and `x-forwarded-proto`/`x-forwarded-host` for Codespaces HTTPS) and **Service Account JSON**.
   - `.devcontainer/devcontainer.json` provisions Node.js 22 + Python 3.11 (`numpy`, `onnxruntime`, `opencv-python-headless`) and runs `scripts/download_models.py` on port `3000`.
   - `.gitignore` excludes `data/config.json`, `data/index.json`, `storage/`, `models/`, `rm6-pink-album-*.json`, and `client_secret_*.json`.

## 2. Project Structure

```text
RM6 Pink album/
├── server.js                      # Node.js HTTP & REST API server (v1.026112026)
├── package.json                   # Version 1.026112026; npm start, npm test
├── .devcontainer/
│   └── devcontainer.json          # GitHub Codespaces setup (Node 22 + Python 3.11 + buffalo_l)
├── lib/
│   ├── arcface-client.js          # Persistent Python ONNX worker bridge (win32 python / linux python3)
│   ├── face-engine.js             # Calibrated 512-D ArcFace clustering & cosine similarity math
│   ├── gemini-face.js             # Gemini Vision borderline face verifier & key tester
│   ├── google-drive.js            # Google Drive v3 OAuth2 + Service Account connector
│   └── zip.js                     # Pure Node.js PKZIP (.zip) archive builder
├── scripts/
│   ├── arcface_worker.py          # SCRFD-10G + ArcFace-R50 512-D ONNX runtime worker
│   ├── download_models.py         # Downloads buffalo_l (det_10g.onnx, w600k_r50.onnx)
│   └── reindex_album.js           # Re-indexes album photos with ArcFace
├── public/
│   ├── index.html                 # Minimal Noto Sans Thai attendee-first UI + Admin/QR/Lightbox modals
│   ├── styles.css                 # GSB Pink stylesheet + force-mobile / force-desktop overrides
│   ├── app.js                     # Client upload, Guest Avatar, LINE share/escape, Admin auth
│   └── qr.js                      # Offline-capable ISO QR Code generator
└── test/
    └── smoke.test.js              # End-to-end automated verification suite
```

## 3. Commands

- **Start server**: `npm start` (`http://localhost:3000`)
- **Run automated tests**: `npm test`
- **Download InsightFace models**: `python scripts/download_models.py` (or `python3` on Linux)
- **Re-index album faces**: `node scripts/reindex_album.js`
