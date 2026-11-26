---
name: rm6-pink-album
description: >-
  Architecture, workflow, and operational guide for the RM6 Pink album web
  application (v1.026112026). Use this skill when configuring, running,
  extending, or troubleshooting the RM6 Pink album system (Landing Page with
  Gradient themes & Bank Logo, Notebook Card Reader & Mobile Web App photo
  upload to Google Drive, InsightFace SCRFD-10G + ArcFace-R50 512-D face
  recognition, Gemini AI verification, 1-3 person co-occurrence search with
  Add Friend popup, Guest Avatar history, LINE in-app browser escape & LINE
  sharing, 2-tab Admin-authenticated Settings, Admin-only photo deletion,
  GitHub Codespaces & Cloudflare Tunnel deployment, QR Code sharing, and ZIP
  downloads).
---

# RM6 Pink Album (`v1.026112026`) — Architecture & Workflow Skill

Tailored event photo-sharing and AI face search system developed for **ธนาคารออมสินภาค 6 (`RM6 Pink Album`)**.

## 1. Core Functional Scope

1. **Landing Page (`#viewLanding`) & 4-Step Guide**:
   - Full-screen entry view with centered **Bank Logo** (`bankLogoDataUrl`), **Title 1**, **Title 2**, **Location 1 & 2**, **Date**, and 6 selectable **Gradient** backgrounds (`gsb_pink`, `pink_vibrant`, `sunset_rose`, `lavender_pink`, `ocean_sky`, `clean_white`).
   - Two CTA buttons: **`🔍 ค้นหารูปภาพ`** and **`📤 อัปโหลดรูป (ตากล้อง) • N รูป`** (live photo count), plus a 4-step guide reminding attendees to download photos within 5 days.
   - Clicking the topbar brand logo returns to the Landing Page.
2. **Attendee-First Search & Gallery (`Noto Sans Thai`)**:
   - **Mobile / Desktop / Auto** display toggle (`#btnToggleViewMode`, persisted in `localStorage`) and large `🔍 ค้นหารูป` / `📤 อัปโหลดรูป` tabs.
   - **People Strip Above Search**: `บุคคลในงาน` (`ดูอีก N ภาพ` badge) sits above the paired search buttons (`📷 ถ่ายภาพใบหน้า` / `🙂 ใช้ภาพที่มีอยู่`) with colored AI status dots (green/yellow).
   - **3-Slot Co-occurrence Search (1–3 People) & Add Friend Popup (`#addFriendModal`)**: Large centered reference card (`140×140`) with `[Primary] + [Friend 1] + [Friend 2]`, letting users add friends via live/uploaded **Friend Selfie** (with preview & `🔄 ถ่ายใหม่ / เปลี่ยนภาพ`) or **Cluster Picker** (`✓` checkmarks), updating matched photos immediately.
   - **Guest Avatar**: Saves latest search face/cluster in `localStorage` (`rm6_guest_avatar_v1`) for 1-click re-search.
   - **Lightbox**: Left/right arrow navigation (`‹` / `›`, keyboard arrows, touch swipe), thin toggleable face boxes (`👁️ ซ่อนกรอบหน้า`), **`ดูภาพขนาดเต็ม (Google Drive)`**, **`💬 แชร์ผ่าน LINE`** (Web Share API + LINE Share URL fallback), and Admin-only **`🗑️ ลบรูป (Admin)`**.
   - **LINE In-App Browser Escape**: QR URL appends `?openExternalBrowser=1`, plus an in-app banner with Chrome/Safari shortcut & Copy Link.
3. **AI Face Analysis & Search Engine**:
   - **InsightFace `buffalo_l` (512-D)**: `det_10g.onnx` (SCRFD-10G) + `w600k_r50.onnx` (ArcFace-R50) via persistent Python ONNX worker (`scripts/arcface_worker.py` + `lib/arcface-client.js`), with calibrated cosine similarity & clustering (`lib/face-engine.js`).
   - **`arcface_gemini` (Default in Settings)**: Hybrid mode sends only up to 14 borderline face crops per search (0–1 Gemini request per search) via `lib/gemini-face.js`.
4. **Admin-Protected 2-Tab Settings (`🎨 ตกแต่ง` / `🔧 Admin`)**:
   - Protected by `POST /api/auth/login` (default password `rm6admin` or `ADMIN_PASSWORD` env var, `x-admin-token` header).
   - **`🎨 ตกแต่ง`**: Event Title, Event Logo (`eventLogoDataUrl`), and all Landing Page fields (Bank Logo, Gradient, Title 1/2, Location 1/2, Date).
   - **`🔧 Admin`**: Gemini API Key + key tester, default engine mode, sensitivity threshold slider, Google Drive Folder URL, OAuth2 Owner Login, Service Account JSON, Admin password change, and full re-index.
   - **Admin-Only Deletion**: `DELETE /api/photos/:id` returns `403` for non-admins and deletes only with valid `x-admin-token`.
5. **Deployment (Local Windows + Cloudflare Tunnel / GitHub Codespaces)**:
   - **PC/Notebook + Cloudflare Tunnel**: Run `npm start` + `cloudflared tunnel --url http://localhost:3000` for free 24/7 HTTPS access with existing local `data/config.json`, `storage/`, and `models/`.
   - **GitHub Codespaces**: `.devcontainer/devcontainer.json` provisions Node.js 22 + Python 3.11 + `scripts/download_models.py` on port `3000`; OAuth callback respects `?origin=` and `x-forwarded-*` headers.
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
│   ├── index.html                 # Landing Page, Search/Upload views, 2-tab Settings, Modals
│   ├── styles.css                 # GSB Pink stylesheet, Landing gradients, Mobile/Desktop overrides
│   ├── app.js                     # Client logic (3-slot friends, Guest Avatar, LINE, Admin auth)
│   └── qr.js                      # Offline-capable ISO QR Code generator
└── test/
    └── smoke.test.js              # End-to-end automated verification suite
```

## 3. Commands

- **Start server**: `npm start` (`http://localhost:3000`)
- **Expose local server over HTTPS**: `cloudflared tunnel --url http://localhost:3000`
- **Run automated tests**: `npm test`
- **Download InsightFace models**: `python scripts/download_models.py` (or `python3` on Linux)
- **Re-index album faces**: `node scripts/reindex_album.js`
