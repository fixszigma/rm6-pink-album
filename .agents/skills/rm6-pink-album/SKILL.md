---
name: rm6-pink-album
description: >-
  Architecture, workflow, and operational guide for the RM6 Pink album web
  application. Use this skill when configuring, running, extending, or
  troubleshooting the RM6 Pink album system (Notebook Card Reader & Mobile Web
  App photo upload to a shared Google Drive folder, HOG + Linear SVM Face
  Detection & Classification, Gemini 3.8 Flash AI Face Verification, Face
  Clustering, Selfie Search, QR Code sharing, and ZIP downloads).
---

# RM6 Pink Album — Architecture & Workflow Skill

Tailored event photo-sharing and AI face search system developed for **ธนาคารออมสินภาค 6 (`RM6 Pink Album`)**.

## 1. Core Functional Scope

1. **Attendee-First Minimal UI (`Noto Sans Thai`)**:
   - Opens directly on the **`🔍 ค้นหารูป`** view optimized for mobile attendees (Selfie camera capture with automatic native `capture="user"` fallback over HTTP LAN, clickable **`บุคคลในงาน`** face cluster avatars, and fast photo download).
   - Separate **`📤 อัปโหลดรูป`** menu tab for mobile photo uploads, Notebook Card Reader file/folder uploads (`webkitdirectory`), Google Drive folder sync, and folder-wide **HOG + Linear SVM** analysis.
   - Footer credit: `ผู้พัฒนา นายพรชาย วงศ์กระจ่าง ธนาคารออมสินภาค 6`.
2. **3 Selectable AI Face Analysis & Search Engines**:
   - **`📐 HOG + Linear SVM`** *(Default)*: Isomorphic Dalal & Triggs `324-D` L2-Hys Histogram of Oriented Gradients + Multi-Scale Sliding-Window Face Detector (`lib/hog-detector-weights.js`) + LIBLINEAR Dual Coordinate Descent `LinearSVC` (`lib/hog-svm.js`). Analyzes both existing folder images, newly uploaded images, and live selfie queries.
   - **`✨ Gemini AI`**: Multimodal close-up face verification using `gemini-3.8-flash` (`thinkingLevel: "LOW"`, IPv4 HTTPS) via `lib/gemini-face.js`.
   - **`⚡ Neural 128-D`**: `SSD MobileNetV1` + 68-landmark `128-D` ResNet descriptors calibrated for Thai faces (`threshold = 0.27` clustering / `0.28` search) in `lib/face-engine.js`.
3. **Google Drive Shared Folder Sync**:
   - Supports **Google Service Account JSON** (for syncing/pulling photos dropped into the shared Google Drive folder) and **Owner OAuth2 Refresh Token** (`/api/drive/oauth/start`, for pushing web uploads into personal `@gmail.com` Google Drive storage quota).

## 2. Project Structure

```text
RM6 Pink album/
├── server.js                      # Node.js v24 HTTP & REST API server
├── package.json                   # Scripts: npm start, npm test
├── lib/
│   ├── hog-svm.js                 # Isomorphic 324-D HOG + Dual Coordinate Descent Linear SVM + NMS
│   ├── hog-detector-weights.js    # Trained HOG + Linear SVM face detector weights
│   ├── face-engine.js             # Calibrated 128-D + HOG clustering & similarity math
│   ├── gemini-face.js             # Gemini 3.8 Flash close-up face verifier & key tester
│   ├── google-drive.js            # Google Drive v3 OAuth2 + Service Account connector
│   └── zip.js                     # Pure Node.js PKZIP (.zip) archive builder
├── scripts/
│   ├── decode_crops_rgba.py       # Pillow image pyramid & 32x32 RGBA crop helper for folder HOG
│   ├── sample_hog_patches.py      # Positive face & negative patch sampler
│   └── train_hog_detector.js      # Trains lib/hog-detector-weights.js
├── public/
│   ├── index.html                 # Minimal Noto Sans Thai attendee-first UI
│   ├── styles.css                 # Minimalist GSB Pink stylesheet
│   ├── app.js                     # Client upload, 3-engine AI search, and mobile selfie capture
│   └── qr.js                      # Offline-capable ISO QR Code generator
└── test/
    └── smoke.test.js              # End-to-end automated verification suite
```

## 3. Commands

- **Start server**: `npm start` (`http://localhost:3000`)
- **Run automated tests**: `npm test`
- **Retrain HOG + Linear SVM face detector**: `node scripts/train_hog_detector.js`
