'use strict';

const http = require('node:http');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const zlib = require('node:zlib');

const { createZipBuffer } = require('./lib/zip');
const { ArcFaceService } = require('./lib/arcface-client');
const {
  ARCFACE_DIM,
  DEFAULT_CLUSTER_COSINE,
  DEFAULT_SEARCH_COSINE,
  sanitizeCosineThreshold,
  normalizeVector,
  recomputeClusters,
  searchByFaceVectors
} = require('./lib/face-engine');
const {
  parseDriveFolderId,
  buildDriveFolderWebUrl,
  buildGoogleOAuthUrl,
  exchangeOAuthCode,
  getDriveAuthMode,
  uploadFileToDrive,
  listDriveFolderImages,
  downloadDriveFile
} = require('./lib/google-drive');
const {
  DEFAULT_GEMINI_MODEL,
  normalizeModelName,
  verifyFacesWithGemini,
  testGeminiConnection
} = require('./lib/gemini-face');

function loadDotEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    const val = line.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}

function getLanOrigin(port) {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return `http://${iface.address}:${port}`;
      }
    }
  }
  return `http://localhost:${port}`;
}

function decodeBase64Data(input) {
  if (!input) return null;
  const str = String(input);
  const commaIdx = str.indexOf(',');
  const rawBase64 = commaIdx >= 0 ? str.slice(commaIdx + 1) : str;
  return Buffer.from(rawBase64, 'base64');
}

function extFromMimeOrName(mimeType = '', fileName = '') {
  const ext = path.extname(fileName || '').toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return ext;
  if (mimeType.includes('png')) return '.png';
  if (mimeType.includes('webp')) return '.webp';
  if (mimeType.includes('gif')) return '.gif';
  return '.jpg';
}

function mimeFromExt(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  return 'image/jpeg';
}

function normalizeEngineMode(rawMode) {
  if (rawMode === 'arcface_gemini' || rawMode === 'gemini') return 'arcface_gemini';
  return 'arcface';
}

function createAppServer(options = {}) {
  const rootDir = options.rootDir || __dirname;
  loadDotEnv(path.join(rootDir, '.env'));

  const dataDir = options.dataDir || path.join(rootDir, 'data');
  const storageDir = options.storageDir || path.join(rootDir, 'storage');
  const originalsDir = path.join(storageDir, 'originals');
  const thumbsDir = path.join(storageDir, 'thumbs');
  const previewsDir = path.join(storageDir, 'previews');
  const avatarsDir = path.join(storageDir, 'avatars');
  const publicDir = path.join(rootDir, 'public');

  const configPath = path.join(dataDir, 'config.json');
  const indexPath = path.join(dataDir, 'index.json');

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(originalsDir, { recursive: true });
  fs.mkdirSync(thumbsDir, { recursive: true });
  fs.mkdirSync(previewsDir, { recursive: true });
  fs.mkdirSync(avatarsDir, { recursive: true });

  const arcFaceService = new ArcFaceService(rootDir);
  if (!options.disableArcFaceAutoStart && arcFaceService.hasModelsOnDisk()) {
    arcFaceService.ensureStarted().catch((err) => {
      console.warn('ArcFace worker pre-warm warning:', err.message);
    });
  }

  const defaultFolderUrl = process.env.GOOGLE_DRIVE_FOLDER_URL || '';
  const defaultFolderId =
    process.env.GOOGLE_DRIVE_FOLDER_ID || parseDriveFolderId(defaultFolderUrl);

  let config = {
    albumTitle: process.env.ALBUM_TITLE || 'RM6 Pink Album',
    eventLogoDataUrl: '',
    bankLogoDataUrl: '',
    landingTitle1: '',
    landingTitle2: '',
    landingLocation1: '',
    landingLocation2: '',
    landingDate: '',
    landingBgGradient: 'gsb_pink',
    adminPassword: process.env.ADMIN_PASSWORD || 'rm6admin',
    driveFolderUrl: defaultFolderUrl || buildDriveFolderWebUrl(defaultFolderId),
    driveFolderId: defaultFolderId,
    googleApiKey: process.env.GOOGLE_API_KEY || '',
    googleOauthToken: process.env.GOOGLE_OAUTH_ACCESS_TOKEN || '',
    oauthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
    oauthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
    oauthRefreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN || '',
    serviceAccountFile: process.env.GOOGLE_SERVICE_ACCOUNT_FILE || '',
    serviceAccountJson: null,
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    enableGeminiAi: process.env.ENABLE_GEMINI_AI !== 'false',
    searchEngineMode: normalizeEngineMode(process.env.SEARCH_ENGINE_MODE || 'arcface_gemini'),
    geminiModel: normalizeModelName(process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL),
    faceMatchThreshold: sanitizeCosineThreshold(process.env.FACE_MATCH_THRESHOLD, DEFAULT_SEARCH_COSINE),
    clusterThreshold: DEFAULT_CLUSTER_COSINE
  };

  const getExpectedAdminToken = () =>
    crypto.createHash('sha256').update(`rm6-pink-admin-v1:${String(config.adminPassword || 'rm6admin')}`).digest('hex');

  const isAdminAuthorized = (req) => {
    const token = String(req.headers['x-admin-token'] || '').trim();
    return Boolean(token && token === getExpectedAdminToken());
  };

  if (fs.existsSync(configPath)) {
    try {
      const savedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      config = { ...config, ...savedConfig };
      config.geminiModel = normalizeModelName(config.geminiModel);
      config.searchEngineMode = normalizeEngineMode(config.searchEngineMode);
      // Migrate old Euclidean 0.27 threshold to ArcFace Cosine 0.38
      if (Number(config.faceMatchThreshold) < 0.31) {
        config.faceMatchThreshold = DEFAULT_SEARCH_COSINE;
      } else {
        config.faceMatchThreshold = sanitizeCosineThreshold(config.faceMatchThreshold, DEFAULT_SEARCH_COSINE);
      }
      if (config.driveFolderUrl && !config.driveFolderId) {
        config.driveFolderId = parseDriveFolderId(config.driveFolderUrl);
      }
      if (!config.geminiApiKey && process.env.GEMINI_API_KEY) {
        config.geminiApiKey = process.env.GEMINI_API_KEY;
      }
    } catch {
      // keep default config
    }
  }

  let db = {
    photos: [],
    clusters: [],
    updatedAt: new Date().toISOString()
  };

  function persistFaceAvatarSync(photoId, faceIdx, rawAvatar) {
    if (!rawAvatar || typeof rawAvatar !== 'string') return '';
    if (rawAvatar.startsWith('/api/avatars/')) return rawAvatar;
    if (!rawAvatar.startsWith('data:image/')) return rawAvatar;
    const buf = decodeBase64Data(rawAvatar);
    if (!buf || !buf.length) return '';
    const fileName = `${photoId}_f${faceIdx}.jpg`;
    const fullPath = path.join(avatarsDir, fileName);
    fs.writeFileSync(fullPath, buf);
    return `/api/avatars/${fileName}`;
  }

  async function persistFaceAvatarAsync(photoId, faceIdx, rawAvatar) {
    if (!rawAvatar || typeof rawAvatar !== 'string') return '';
    if (rawAvatar.startsWith('/api/avatars/')) return rawAvatar;
    if (!rawAvatar.startsWith('data:image/')) return rawAvatar;
    const buf = decodeBase64Data(rawAvatar);
    if (!buf || !buf.length) return '';
    const fileName = `${photoId}_f${faceIdx}.jpg`;
    const fullPath = path.join(avatarsDir, fileName);
    await fsp.writeFile(fullPath, buf);
    return `/api/avatars/${fileName}`;
  }

  async function loadAvatarBufferFromUrl(avatarUrl) {
    if (!avatarUrl || typeof avatarUrl !== 'string') return null;
    if (avatarUrl.startsWith('/api/avatars/')) {
      const safeName = path.basename(avatarUrl);
      const p = path.join(avatarsDir, safeName);
      if (fs.existsSync(p)) return fsp.readFile(p);
      return null;
    }
    if (avatarUrl.startsWith('data:image/')) {
      return decodeBase64Data(avatarUrl);
    }
    return null;
  }

  if (fs.existsSync(indexPath)) {
    try {
      const savedDb = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      db.photos = Array.isArray(savedDb.photos) ? savedDb.photos : [];
      db.clusters = Array.isArray(savedDb.clusters) ? savedDb.clusters : [];
      let migratedCount = 0;
      for (const p of db.photos) {
        if (Array.isArray(p.faces)) {
          for (let fi = 0; fi < p.faces.length; fi++) {
            const f = p.faces[fi];
            if (f && typeof f.avatarDataUrl === 'string' && f.avatarDataUrl.startsWith('data:image/')) {
              f.avatarDataUrl = persistFaceAvatarSync(p.id, fi, f.avatarDataUrl);
              migratedCount++;
            }
          }
        }
      }
      db.clusters = recomputeClusters(db.photos, db.clusters, config.clusterThreshold || DEFAULT_CLUSTER_COSINE);
      if (migratedCount > 0) {
        db.updatedAt = new Date().toISOString();
        const tmp = `${indexPath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(db), 'utf8');
        fs.renameSync(tmp, indexPath);
        console.log(`⚡ Migrated ${migratedCount} Base64 face avatars to storage/avatars/ and compacted index.json`);
      }
    } catch {
      // keep empty db
    }
  }

  function saveConfig() {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  }

  let saveTimer = null;
  let reclusterTimer = null;

  function saveDb() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    db.updatedAt = new Date().toISOString();
    const tmp = `${indexPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db), 'utf8');
    fs.renameSync(tmp, indexPath);
  }

  function scheduleReclusterAndSave(delayMs = 600) {
    if (reclusterTimer) clearTimeout(reclusterTimer);
    reclusterTimer = setTimeout(() => {
      reclusterTimer = null;
      db.clusters = recomputeClusters(db.photos, db.clusters, config.clusterThreshold || DEFAULT_CLUSTER_COSINE);
      db.updatedAt = new Date().toISOString();
      const tmp = `${indexPath}.${process.pid}.tmp`;
      fsp.writeFile(tmp, JSON.stringify(db), 'utf8')
        .then(() => fsp.rename(tmp, indexPath))
        .catch(() => {});
    }, delayMs);
  }

  // Background Google Drive Upload Queue (2 concurrent workers so uploads never block photographers!)
  const driveQueue = [];
  let activeDriveWorkers = 0;
  const MAX_DRIVE_CONCURRENCY = 2;

  function pumpDriveQueue() {
    while (activeDriveWorkers < MAX_DRIVE_CONCURRENCY && driveQueue.length > 0) {
      const photo = driveQueue.shift();
      if (!photo || photo.driveSynced) continue;
      const folderId = config.driveFolderId || parseDriveFolderId(config.driveFolderUrl);
      if (!folderId) continue;

      activeDriveWorkers++;
      (async () => {
        try {
          const origPath = path.join(originalsDir, photo.origFileName || '');
          if (!fs.existsSync(origPath)) return;
          const buf = await fsp.readFile(origPath);
          const driveRes = await uploadFileToDrive(config, {
            fileName: photo.name,
            mimeType: photo.mimeType,
            buffer: buf
          });
          if (driveRes && driveRes.synced) {
            photo.driveFileId = driveRes.driveFileId || '';
            photo.driveSynced = true;
            photo.driveSyncNote = '';
            photo.webViewLink = driveRes.webViewLink || '';
            scheduleReclusterAndSave(1200);
          } else if (driveRes && driveRes.reason) {
            photo.driveSyncNote = driveRes.reason;
          }
        } catch (err) {
          photo.driveSyncNote = err.message || 'Drive background upload error';
        } finally {
          activeDriveWorkers--;
          pumpDriveQueue();
        }
      })();
    }
  }

  function enqueueDriveUpload(photo) {
    const folderId = config.driveFolderId || parseDriveFolderId(config.driveFolderUrl);
    if (!folderId || photo.driveSynced) return;
    driveQueue.push(photo);
    pumpDriveQueue();
  }

  let currentAcceptEncoding = '';

  function sendJson(res, statusCode, payload) {
    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    };
    if (raw.length > 1024 && currentAcceptEncoding.includes('gzip')) {
      const gz = zlib.gzipSync(raw, { level: zlib.constants.Z_BEST_SPEED });
      headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = String(gz.length);
      res.writeHead(statusCode, headers);
      res.end(gz);
      return;
    }
    headers['Content-Length'] = String(raw.length);
    res.writeHead(statusCode, headers);
    res.end(raw);
  }

  function readRawBody(req, maxBytes = 55 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      req.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          reject(new Error('ขนาดไฟล์เกินกำหนด (สูงสุด ~55MB ต่อรูป)'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function streamFileWithCache(req, res, filePath, contentType, { cacheControl = 'public, max-age=604800, immutable', downloadName = '' } = {}) {
    let stat;
    try {
      stat = fs.statSync(filePath);
      if (!stat.isFile()) return false;
    } catch {
      return false;
    }
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    if (!downloadName && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl });
      res.end();
      return true;
    }
    const headers = {
      'Content-Type': contentType,
      'Content-Length': String(stat.size),
      'Cache-Control': cacheControl,
      ETag: etag
    };
    if (downloadName) {
      const encodedName = encodeURIComponent(downloadName);
      headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodedName}`;
    }
    res.writeHead(200, headers);
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    stream.pipe(res);
    return true;
  }

  function readJsonBody(req, maxBytes = 65 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      req.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          reject(new Error('ขนาดข้อมูลเกินกำหนด (สูงสุด ~65MB ต่อครั้ง)'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve(text ? JSON.parse(text) : {});
        } catch (err) {
          reject(new Error(`รูปแบบ JSON ไม่ถูกต้อง: ${err.message}`));
        }
      });
      req.on('error', reject);
    });
  }

  function buildPublicPhotoView(photo, opts = {}) {
    const view = {
      id: photo.id,
      name: photo.name,
      mimeType: photo.mimeType,
      size: photo.size,
      width: photo.width || 0,
      height: photo.height || 0,
      source: photo.source || 'web_upload',
      createdAt: photo.createdAt,
      driveFileId: photo.driveFileId || '',
      driveSynced: Boolean(photo.driveSynced),
      driveSyncNote: photo.driveSyncNote || '',
      webViewLink: photo.webViewLink || (photo.driveFileId ? `https://drive.google.com/file/d/${photo.driveFileId}/view` : ''),
      thumbUrl: `/api/photos/${photo.id}/thumb`,
      previewUrl: `/api/photos/${photo.id}/preview`,
      fileUrl: `/api/photos/${photo.id}/file`,
      downloadUrl: `/api/photos/${photo.id}/file?download=1`,
      faceIndexed: Boolean(photo.faceIndexed),
      needsFaceIndex: !photo.faceIndexed,
      faceCount: Array.isArray(photo.faces) ? photo.faces.length : 0,
      clusterIds: Array.isArray(photo.clusterIds) ? photo.clusterIds : []
    };
    if (opts.includeFaces) {
      view.faces = (photo.faces || []).map((f, idx) => ({
        index: idx,
        box: f.box || null,
        detScore: f.detScore || 0,
        clusterEligible: f.clusterEligible !== false,
        clusterId: f.clusterId || null,
        avatarDataUrl: f.avatarDataUrl || ''
      }));
    }
    return view;
  }

  function buildPublicClusterView(cluster) {
    return {
      id: cluster.id,
      label: cluster.label,
      customLabel: cluster.customLabel || '',
      avatarDataUrl: cluster.avatarDataUrl || '',
      photoCount: cluster.photoCount,
      faceCount: cluster.faceCount,
      photoIds: cluster.photoIds
    };
  }

  function getStats() {
    let totalFaces = 0;
    let arcfaceFaces = 0;
    let indexedPhotos = 0;
    let driveSyncedPhotos = 0;
    for (const p of db.photos) {
      if (p.faceIndexed) indexedPhotos++;
      if (p.driveSynced) driveSyncedPhotos++;
      if (Array.isArray(p.faces)) {
        totalFaces += p.faces.length;
        for (const f of p.faces) {
          if (Array.isArray(f.descriptor) && f.descriptor.length === ARCFACE_DIM) {
            arcfaceFaces++;
          }
        }
      }
    }
    return {
      totalPhotos: db.photos.length,
      indexedPhotos,
      unindexedPhotos: db.photos.length - indexedPhotos,
      driveSyncedPhotos,
      totalFaces,
      arcfaceFaces,
      totalClusters: db.clusters.length
    };
  }

  async function loadThumbBufferForPhoto(photo) {
    const thumbPath = path.join(thumbsDir, photo.thumbFileName || photo.origFileName || '');
    if (thumbPath && fs.existsSync(thumbPath) && fs.statSync(thumbPath).isFile()) {
      return fsp.readFile(thumbPath);
    }
    const origPath = path.join(originalsDir, photo.origFileName || '');
    if (origPath && fs.existsSync(origPath) && fs.statSync(origPath).isFile()) {
      return fsp.readFile(origPath);
    }
    return null;
  }

  /**
   * Indexes an array of photo records on the server using InsightFace (SCRFD-10G + ArcFace-R50 512-D).
   */
  async function indexPhotosWithArcFace(targetPhotos) {
    if (!targetPhotos.length || !arcFaceService.hasModelsOnDisk()) {
      return { indexedCount: 0, totalFaces: 0 };
    }

    const batchItems = [];
    for (const p of targetPhotos) {
      const origPath = path.join(originalsDir, p.origFileName || '');
      if (p.origFileName && fs.existsSync(origPath)) {
        const thumbFileName = p.thumbFileName || `${p.id}_thumb.jpg`;
        const previewFileName = p.previewFileName || `${p.id}_preview.jpg`;
        p.thumbFileName = thumbFileName;
        p.previewFileName = previewFileName;
        batchItems.push({
          id: p.id,
          imagePath: origPath,
          saveThumbPath: path.join(thumbsDir, thumbFileName),
          savePreviewPath: path.join(previewsDir, previewFileName)
        });
      }
    }

    if (!batchItems.length) return { indexedCount: 0, totalFaces: 0 };

    let indexedCount = 0;
    let totalFaces = 0;
    const CHUNK = 12;

    for (let i = 0; i < batchItems.length; i += CHUNK) {
      const slice = batchItems.slice(i, i + CHUNK);
      const out = await arcFaceService.analyzeBatchPaths(slice);
      const resMap = out.results || {};
      for (const item of slice) {
        const photo = db.photos.find((x) => x.id === item.id);
        const r = resMap[item.id];
        if (!photo || !r) continue;
        photo.width = r.width || photo.width;
        photo.height = r.height || photo.height;
        const nextFaces = [];
        const rawFaces = r.faces || [];
        for (let fi = 0; fi < rawFaces.length; fi++) {
          const f = rawFaces[fi];
          const avatarUrl = await persistFaceAvatarAsync(photo.id, fi, f.avatarDataUrl || '');
          nextFaces.push({
            descriptor: normalizeVector(f.descriptor),
            box: f.box,
            detScore: f.detScore,
            blurScore: f.blurScore,
            clusterEligible: f.clusterEligible !== false,
            avatarDataUrl: avatarUrl
          });
        }
        photo.faces = nextFaces;
        photo.faceIndexed = true;
        photo.engineVersion = 'arcface_512d';
        indexedCount++;
        totalFaces += photo.faces.length;
      }
    }

    db.clusters = recomputeClusters(db.photos, db.clusters, config.clusterThreshold || DEFAULT_CLUSTER_COSINE);
    saveDb();
    return { indexedCount, totalFaces };
  }

  const server = http.createServer(async (req, res) => {
    try {
      currentAcceptEncoding = String(req.headers['accept-encoding'] || '');
      const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = reqUrl.pathname;
      const method = req.method.toUpperCase();

      // 1. GET /api/status
      if (method === 'GET' && pathname === '/api/status') {
        const addr = server.address();
        const activePort = (addr && typeof addr === 'object' ? addr.port : 3000);
        const folderId = config.driveFolderId || parseDriveFolderId(config.driveFolderUrl);
        return sendJson(res, 200, {
          ok: true,
          appVersion: '1.026112026',
          albumTitle: config.albumTitle,
          eventLogoDataUrl: config.eventLogoDataUrl || '',
          bankLogoDataUrl: config.bankLogoDataUrl || '',
          landingTitle1: config.landingTitle1 || '',
          landingTitle2: config.landingTitle2 || '',
          landingLocation1: config.landingLocation1 || '',
          landingLocation2: config.landingLocation2 || '',
          landingDate: config.landingDate || '',
          landingBgGradient: config.landingBgGradient || 'gsb_pink',
          bankLogoDataUrl: config.bankLogoDataUrl || '',
          landingTitle1: config.landingTitle1 || '',
          landingTitle2: config.landingTitle2 || '',
          landingLocation1: config.landingLocation1 || '',
          landingLocation2: config.landingLocation2 || '',
          landingDate: config.landingDate || '',
          landingBgGradient: config.landingBgGradient || 'gsb_pink',
          driveFolderId: folderId,
          driveFolderUrl: folderId ? buildDriveFolderWebUrl(folderId) : (config.driveFolderUrl || ''),
          driveAuthMode: getDriveAuthMode(config),
          hasApiKey: Boolean(config.googleApiKey),
          hasOauthToken: Boolean(config.googleOauthToken || config.oauthRefreshToken),
          hasOauthOwner: Boolean(config.oauthRefreshToken && config.oauthClientId && config.oauthClientSecret),
          oauthClientId: config.oauthClientId || '',
          hasServiceAccount: Boolean(
            (config.serviceAccountJson && config.serviceAccountJson.client_email) ||
            (config.serviceAccountFile && fs.existsSync(config.serviceAccountFile))
          ),
          arcFaceReady: arcFaceService.hasModelsOnDisk(),
          hasGeminiKey: Boolean(config.geminiApiKey && String(config.geminiApiKey).trim()),
          enableGeminiAi: Boolean(config.enableGeminiAi),
          searchEngineMode: config.searchEngineMode || 'arcface_gemini',
          geminiModel: config.geminiModel || DEFAULT_GEMINI_MODEL,
          faceMatchThreshold: config.faceMatchThreshold,
          lanUrl: getLanOrigin(activePort),
          stats: getStats()
        });
      }

      // 1b. Admin Auth for Settings
      if (method === 'POST' && pathname === '/api/auth/login') {
        const body = await readJsonBody(req);
        const pwd = String(body.password || '');
        if (!pwd || pwd !== String(config.adminPassword || 'rm6admin')) {
          return sendJson(res, 401, { ok: false, error: 'รหัสผ่านผู้ดูแลไม่ถูกต้อง' });
        }
        const token = getExpectedAdminToken();
        return sendJson(res, 200, { ok: true, token });
      }

      if (method === 'GET' && pathname === '/api/auth/verify') {
        return sendJson(res, 200, { ok: true, authenticated: isAdminAuthorized(req) });
      }

      // 2. POST /api/config (Protected by Admin Login)
      if (method === 'POST' && pathname === '/api/config') {
        if (!isAdminAuthorized(req)) {
          return sendJson(res, 401, { ok: false, error: 'กรุณาเข้าสู่ระบบผู้ดูแลก่อนแก้ไขตั้งค่า' });
        }
        const body = await readJsonBody(req);
        if (typeof body.albumTitle === 'string' && body.albumTitle.trim()) {
          config.albumTitle = body.albumTitle.trim();
        }
        if (typeof body.eventLogoDataUrl === 'string') {
          config.eventLogoDataUrl = body.eventLogoDataUrl.trim();
        }
        if (typeof body.bankLogoDataUrl === 'string') {
          config.bankLogoDataUrl = body.bankLogoDataUrl.trim();
        }
        if (typeof body.landingTitle1 === 'string') config.landingTitle1 = body.landingTitle1.trim();
        if (typeof body.landingTitle2 === 'string') config.landingTitle2 = body.landingTitle2.trim();
        if (typeof body.landingLocation1 === 'string') config.landingLocation1 = body.landingLocation1.trim();
        if (typeof body.landingLocation2 === 'string') config.landingLocation2 = body.landingLocation2.trim();
        if (typeof body.landingDate === 'string') config.landingDate = body.landingDate.trim();
        if (typeof body.landingBgGradient === 'string' && body.landingBgGradient.trim()) {
          config.landingBgGradient = body.landingBgGradient.trim();
        }
        if (typeof body.newAdminPassword === 'string' && body.newAdminPassword.trim()) {
          config.adminPassword = body.newAdminPassword.trim();
        }
        if (typeof body.driveFolderUrl === 'string') {
          const parsedId = parseDriveFolderId(body.driveFolderUrl);
          config.driveFolderId = parsedId;
          config.driveFolderUrl = parsedId
            ? buildDriveFolderWebUrl(parsedId)
            : body.driveFolderUrl.trim();
        }
        if (typeof body.driveFolderId === 'string' && body.driveFolderId.trim()) {
          const parsedId = parseDriveFolderId(body.driveFolderId);
          config.driveFolderId = parsedId;
          config.driveFolderUrl = buildDriveFolderWebUrl(parsedId);
        }
        if (typeof body.googleApiKey === 'string' && body.googleApiKey.trim()) {
          config.googleApiKey = body.googleApiKey.trim();
        } else if (body.clearGoogleApiKey === true) {
          config.googleApiKey = '';
        }
        if (typeof body.geminiApiKey === 'string') {
          const trimmedKey = body.geminiApiKey.trim();
          if (trimmedKey && !trimmedKey.startsWith('••••')) {
            config.geminiApiKey = trimmedKey;
          } else if (trimmedKey === '') {
            config.geminiApiKey = '';
          }
        }
        if (typeof body.enableGeminiAi === 'boolean') {
          config.enableGeminiAi = body.enableGeminiAi;
        }
        if (typeof body.searchEngineMode === 'string') {
          config.searchEngineMode = normalizeEngineMode(body.searchEngineMode);
          config.enableGeminiAi = config.searchEngineMode === 'arcface_gemini';
        }
        if (typeof body.geminiModel === 'string' && body.geminiModel.trim()) {
          config.geminiModel = body.geminiModel.trim();
        }
        if (typeof body.googleOauthToken === 'string' && body.googleOauthToken.trim()) {
          config.googleOauthToken = body.googleOauthToken.trim();
        }
        if (typeof body.oauthClientId === 'string') {
          config.oauthClientId = body.oauthClientId.trim();
        }
        if (typeof body.oauthClientSecret === 'string' && body.oauthClientSecret.trim() && !body.oauthClientSecret.startsWith('••••')) {
          config.oauthClientSecret = body.oauthClientSecret.trim();
        }
        if (body.serviceAccountJson !== undefined) {
          if (typeof body.serviceAccountJson === 'string' && body.serviceAccountJson.trim()) {
            config.serviceAccountJson = JSON.parse(body.serviceAccountJson.trim());
          } else if (typeof body.serviceAccountJson === 'object' && body.serviceAccountJson !== null) {
            config.serviceAccountJson = body.serviceAccountJson;
          } else if (body.serviceAccountJson === '') {
            config.serviceAccountJson = null;
          }
        }
        if (body.faceMatchThreshold !== undefined) {
          config.faceMatchThreshold = sanitizeCosineThreshold(body.faceMatchThreshold, DEFAULT_SEARCH_COSINE);
        }

        saveConfig();
        return sendJson(res, 200, {
          ok: true,
          appVersion: '1.026112026',
          albumTitle: config.albumTitle,
          eventLogoDataUrl: config.eventLogoDataUrl || '',
          bankLogoDataUrl: config.bankLogoDataUrl || '',
          landingTitle1: config.landingTitle1 || '',
          landingTitle2: config.landingTitle2 || '',
          landingLocation1: config.landingLocation1 || '',
          landingLocation2: config.landingLocation2 || '',
          landingDate: config.landingDate || '',
          landingBgGradient: config.landingBgGradient || 'gsb_pink',
          bankLogoDataUrl: config.bankLogoDataUrl || '',
          landingTitle1: config.landingTitle1 || '',
          landingTitle2: config.landingTitle2 || '',
          landingLocation1: config.landingLocation1 || '',
          landingLocation2: config.landingLocation2 || '',
          landingDate: config.landingDate || '',
          landingBgGradient: config.landingBgGradient || 'gsb_pink',
          driveFolderId: config.driveFolderId,
          driveFolderUrl: config.driveFolderUrl,
          driveAuthMode: getDriveAuthMode(config),
          hasGeminiKey: Boolean(config.geminiApiKey && String(config.geminiApiKey).trim()),
          enableGeminiAi: Boolean(config.enableGeminiAi),
          searchEngineMode: config.searchEngineMode,
          geminiModel: config.geminiModel,
          faceMatchThreshold: config.faceMatchThreshold,
          stats: getStats()
        });
      }

      // 2a. GET /api/drive/oauth/start & /api/drive/oauth/callback
      const getOAuthRedirectUri = (r, u) => {
        const originParam = u && u.searchParams ? u.searchParams.get('origin') : '';
        if (originParam && /^https?:\/\/[^/]+$/i.test(originParam.trim())) {
          return `${originParam.trim()}/api/drive/oauth/callback`;
        }
        const proto = String(r.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
        const host = String(r.headers['x-forwarded-host'] || r.headers.host || 'localhost:3000').split(',')[0].trim();
        return `${proto}://${host}/api/drive/oauth/callback`;
      };

      if (method === 'GET' && pathname === '/api/drive/oauth/start') {
        const redirectUri = getOAuthRedirectUri(req, reqUrl);
        global.__lastOAuthRedirectUri = redirectUri;
        const authUrl = buildGoogleOAuthUrl(config, redirectUri);
        res.writeHead(302, { Location: authUrl });
        return res.end();
      }

      if (method === 'GET' && pathname === '/api/drive/oauth/callback') {
        const code = reqUrl.searchParams.get('code') || '';
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end('<h3>ไม่พบรหัสยืนยันจาก Google OAuth</h3><a href="/">กลับหน้าหลัก</a>');
        }
        const redirectUri = global.__lastOAuthRedirectUri || getOAuthRedirectUri(req, reqUrl);
        const tokens = await exchangeOAuthCode(config, code, redirectUri);
        if (tokens.refreshToken) config.oauthRefreshToken = tokens.refreshToken;
        if (tokens.accessToken) config.googleOauthToken = tokens.accessToken;
        saveConfig();
        res.writeHead(302, { Location: '/?oauth=connected' });
        return res.end();
      }

      // 2b. POST /api/gemini/test
      if (method === 'POST' && pathname === '/api/gemini/test') {
        const body = await readJsonBody(req);
        const typedKey =
          (typeof body.geminiApiKey === 'string' && body.geminiApiKey.trim() && !body.geminiApiKey.trim().startsWith('••••'))
            ? body.geminiApiKey.trim()
            : '';
        const candidateKey = typedKey || config.geminiApiKey;

        try {
          const check = await testGeminiConnection({
            apiKey: candidateKey,
            model: config.geminiModel || DEFAULT_GEMINI_MODEL
          });
          if (typedKey) {
            config.geminiApiKey = typedKey;
            config.geminiModel = check.modelUsed || config.geminiModel;
            saveConfig();
          }
          return sendJson(res, 200, {
            ok: true,
            saved: Boolean(typedKey),
            modelUsed: check.modelUsed,
            providerUsed: check.providerUsed,
            durationMs: check.durationMs
          });
        } catch (err) {
          return sendJson(res, 400, {
            ok: false,
            error: err.message || 'ทดสอบ Gemini API ไม่สำเร็จ'
          });
        }
      }

      // 3. GET /api/photos (supports ?limit=40&offset=0&clusterId=...&clusterLimit=40)
      if (method === 'GET' && pathname === '/api/photos') {
        const clusterFilter = reqUrl.searchParams.get('clusterId') || '';
        const limitParam = Number(reqUrl.searchParams.get('limit') || 0);
        const offsetParam = Math.max(0, Number(reqUrl.searchParams.get('offset') || 0) || 0);
        const clusterLimitParam = Number(reqUrl.searchParams.get('clusterLimit') || 0);

        let list = db.photos;
        if (clusterFilter) {
          list = list.filter((p) => Array.isArray(p.clusterIds) && p.clusterIds.includes(clusterFilter));
        }

        const totalFiltered = list.length;
        const pageList = limitParam > 0 ? list.slice(offsetParam, offsetParam + limitParam) : list;
        const clusterSlice = clusterLimitParam > 0 ? db.clusters.slice(0, clusterLimitParam) : db.clusters;

        return sendJson(res, 200, {
          ok: true,
          photos: pageList.map((p) => buildPublicPhotoView(p, { includeFaces: false })),
          totalFiltered,
          hasMore: limitParam > 0 ? (offsetParam + pageList.length < totalFiltered) : false,
          clusters: clusterSlice.map(buildPublicClusterView),
          totalClusters: db.clusters.length,
          stats: getStats()
        });
      }

      // 3a. GET /api/photos/:id/faces (Lazy-loaded only when Lightbox opens a photo)
      const photoFacesMatch = pathname.match(/^\/api\/photos\/([a-zA-Z0-9_-]+)\/faces$/);
      if (method === 'GET' && photoFacesMatch) {
        const photo = db.photos.find((p) => p.id === photoFacesMatch[1]);
        if (!photo) {
          return sendJson(res, 404, { ok: false, error: 'ไม่พบรูปภาพนี้' });
        }
        return sendJson(res, 200, {
          ok: true,
          width: photo.width || 0,
          height: photo.height || 0,
          faces: (photo.faces || []).map((f, idx) => ({
            index: idx,
            box: f.box || null,
            detScore: f.detScore || 0,
            clusterId: f.clusterId || null,
            avatarDataUrl: f.avatarDataUrl || ''
          }))
        });
      }

      // 3b. POST /api/photos/reindex-arcface & POST /api/photos/reset-faces
      if (method === 'POST' && (pathname === '/api/photos/reindex-arcface' || pathname === '/api/photos/reset-faces')) {
        if (!options.disableArcFaceAutoStart && arcFaceService.hasModelsOnDisk()) {
          const reRes = await indexPhotosWithArcFace(db.photos);
          return sendJson(res, 200, {
            ok: true,
            indexedCount: reRes.indexedCount,
            totalFaces: reRes.totalFaces,
            photos: db.photos.map(buildPublicPhotoView),
            clusters: db.clusters.map(buildPublicClusterView),
            stats: getStats()
          });
        }

        for (const p of db.photos) {
          p.faceIndexed = false;
          p.faces = [];
          p.clusterIds = [];
        }
        db.clusters = [];
        saveDb();
        return sendJson(res, 200, {
          ok: true,
          photos: db.photos.map(buildPublicPhotoView),
          clusters: [],
          stats: getStats()
        });
      }

      // 4a. POST /api/photos/upload-binary (Zero-Base64 High-Speed Parallel Upload + Background Drive Queue)
      if (method === 'POST' && pathname === '/api/photos/upload-binary') {
        const origBuf = await readRawBody(req);
        if (!origBuf || !origBuf.length) {
          return sendJson(res, 400, { ok: false, error: 'ไม่มีข้อมูลไฟล์รูปภาพ' });
        }

        const id = `ph_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const rawName = String(reqUrl.searchParams.get('name') || `${id}.jpg`).trim();
        const mimeType = String(reqUrl.searchParams.get('mimeType') || req.headers['content-type'] || 'image/jpeg');
        const source = String(reqUrl.searchParams.get('source') || 'web_upload_binary');
        const deferCluster = reqUrl.searchParams.get('deferCluster') === '1';
        const ext = extFromMimeOrName(mimeType, rawName);

        const origFileName = `${id}${ext}`;
        const thumbFileName = `${id}_thumb.jpg`;
        const previewFileName = `${id}_preview.jpg`;
        const origFullPath = path.join(originalsDir, origFileName);
        const thumbFullPath = path.join(thumbsDir, thumbFileName);
        const previewFullPath = path.join(previewsDir, previewFileName);

        await fsp.writeFile(origFullPath, origBuf);

        let normalizedFaces = [];
        let width = Number(reqUrl.searchParams.get('width')) || 0;
        let height = Number(reqUrl.searchParams.get('height')) || 0;
        let faceIndexed = false;
        const useServerArcFace = !options.disableArcFaceAutoStart && arcFaceService.hasModelsOnDisk();

        if (useServerArcFace) {
          const analyzed = await arcFaceService.analyzeImage({
            imagePath: origFullPath,
            saveThumbPath: thumbFullPath,
            savePreviewPath: previewFullPath,
            scoreThresh: 0.45,
            flipAugment: true
          });
          width = analyzed.width || width;
          height = analyzed.height || height;
          const rawFaces = analyzed.faces || [];
          for (let fi = 0; fi < rawFaces.length; fi++) {
            const f = rawFaces[fi];
            const avatarUrl = await persistFaceAvatarAsync(id, fi, f.avatarDataUrl || '');
            normalizedFaces.push({
              descriptor: normalizeVector(f.descriptor),
              box: f.box,
              detScore: f.detScore,
              blurScore: f.blurScore,
              clusterEligible: f.clusterEligible !== false,
              avatarDataUrl: avatarUrl
            });
          }
          faceIndexed = true;
        } else {
          await fsp.writeFile(thumbFullPath, origBuf);
        }

        const photoRecord = {
          id,
          name: rawName,
          mimeType,
          size: origBuf.length,
          width,
          height,
          source,
          createdAt: new Date().toISOString(),
          origFileName,
          thumbFileName,
          previewFileName,
          driveFileId: '',
          driveSynced: false,
          driveSyncNote: 'รอซิงก์ขึ้น Google Drive เบื้องหลัง',
          webViewLink: '',
          faceIndexed,
          engineVersion: useServerArcFace ? 'arcface_512d' : 'custom',
          faces: normalizedFaces,
          clusterIds: []
        };

        db.photos.unshift(photoRecord);
        enqueueDriveUpload(photoRecord);

        if (deferCluster) {
          scheduleReclusterAndSave(800);
        } else {
          db.clusters = recomputeClusters(db.photos, db.clusters, config.clusterThreshold || DEFAULT_CLUSTER_COSINE);
          saveDb();
        }

        return sendJson(res, 200, {
          ok: true,
          photo: buildPublicPhotoView(photoRecord),
          driveQueued: Boolean(config.driveFolderId || parseDriveFolderId(config.driveFolderUrl))
        });
      }

      if (method === 'POST' && pathname === '/api/photos/recluster') {
        db.clusters = recomputeClusters(db.photos, db.clusters, config.clusterThreshold || DEFAULT_CLUSTER_COSINE);
        saveDb();
        return sendJson(res, 200, {
          ok: true,
          clusters: db.clusters.slice(0, 60).map(buildPublicClusterView),
          totalClusters: db.clusters.length,
          stats: getStats()
        });
      }

      // 4. POST /api/photos/upload (JSON Base64 Compatible + Background Drive Queue + Avatar Files)
      if (method === 'POST' && pathname === '/api/photos/upload') {
        const body = await readJsonBody(req);
        const files = Array.isArray(body.files) ? body.files : [];
        if (!files.length) {
          return sendJson(res, 400, { ok: false, error: 'ไม่มีไฟล์รูปภาพที่ส่งมา' });
        }

        const addedPhotos = [];
        const useServerArcFace = !options.disableArcFaceAutoStart && arcFaceService.hasModelsOnDisk() && !Array.isArray(files[0]?.faces);

        for (const item of files) {
          const origBuf = decodeBase64Data(item.dataBase64);
          if (!origBuf || !origBuf.length) continue;

          const thumbBuf = decodeBase64Data(item.thumbBase64) || origBuf;
          const id = `ph_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
          const rawName = String(item.name || `${id}.jpg`).trim();
          const mimeType = String(item.mimeType || 'image/jpeg');
          const ext = extFromMimeOrName(mimeType, rawName);

          const origFileName = `${id}${ext}`;
          const thumbFileName = `${id}_thumb.jpg`;
          const previewFileName = `${id}_preview.jpg`;
          const origFullPath = path.join(originalsDir, origFileName);
          const thumbFullPath = path.join(thumbsDir, thumbFileName);
          const previewFullPath = path.join(previewsDir, previewFileName);

          await fsp.writeFile(origFullPath, origBuf);
          await fsp.writeFile(thumbFullPath, thumbBuf);

          let normalizedFaces = [];
          let width = Number(item.width) || 0;
          let height = Number(item.height) || 0;
          let faceIndexed = false;

          if (useServerArcFace) {
            const analyzed = await arcFaceService.analyzeImage({
              imagePath: origFullPath,
              saveThumbPath: item.thumbBase64 ? undefined : thumbFullPath,
              savePreviewPath: previewFullPath,
              scoreThresh: 0.45,
              flipAugment: true
            });
            width = analyzed.width || width;
            height = analyzed.height || height;
            const rawFaces = analyzed.faces || [];
            for (let fi = 0; fi < rawFaces.length; fi++) {
              const f = rawFaces[fi];
              const avatarUrl = await persistFaceAvatarAsync(id, fi, f.avatarDataUrl || '');
              normalizedFaces.push({
                descriptor: normalizeVector(f.descriptor),
                box: f.box,
                detScore: f.detScore,
                blurScore: f.blurScore,
                clusterEligible: f.clusterEligible !== false,
                avatarDataUrl: avatarUrl
              });
            }
            faceIndexed = true;
          } else if (Array.isArray(item.faces)) {
            for (let fi = 0; fi < item.faces.length; fi++) {
              const f = item.faces[fi];
              const desc = normalizeVector(f.descriptor);
              if (!desc.length) continue;
              const avatarUrl = await persistFaceAvatarAsync(id, fi, f.avatarDataUrl || '');
              normalizedFaces.push({
                descriptor: desc,
                box: f.box || null,
                detScore: f.detScore || 0.9,
                clusterEligible: f.clusterEligible !== false,
                avatarDataUrl: avatarUrl
              });
            }
            faceIndexed = true;
          }

          const photoRecord = {
            id,
            name: rawName,
            mimeType,
            size: origBuf.length,
            width,
            height,
            source: item.source || 'web_upload',
            createdAt: new Date().toISOString(),
            origFileName,
            thumbFileName,
            previewFileName,
            driveFileId: '',
            driveSynced: false,
            driveSyncNote: '',
            webViewLink: '',
            faceIndexed,
            engineVersion: useServerArcFace ? 'arcface_512d' : 'custom',
            faces: normalizedFaces,
            clusterIds: []
          };

          db.photos.unshift(photoRecord);
          addedPhotos.push(photoRecord);
          enqueueDriveUpload(photoRecord);
        }

        db.clusters = recomputeClusters(db.photos, db.clusters, config.clusterThreshold || DEFAULT_CLUSTER_COSINE);
        saveDb();

        return sendJson(res, 200, {
          ok: true,
          addedCount: addedPhotos.length,
          addedPhotos: addedPhotos.map(buildPublicPhotoView),
          clusters: db.clusters.map(buildPublicClusterView),
          stats: getStats()
        });
      }

      // 5. PATCH /api/clusters/:id
      const clusterMatch = pathname.match(/^\/api\/clusters\/([a-zA-Z0-9_-]+)$/);
      if (method === 'PATCH' && clusterMatch) {
        const clusterId = clusterMatch[1];
        const cluster = db.clusters.find((c) => c.id === clusterId);
        if (!cluster) {
          return sendJson(res, 404, { ok: false, error: 'ไม่พบกลุ่มใบหน้านี้' });
        }
        const body = await readJsonBody(req);
        const newLabel = String(body.label || '').trim();
        cluster.customLabel = newLabel;
        cluster.label = newLabel || cluster.label;
        saveDb();
        return sendJson(res, 200, {
          ok: true,
          cluster: buildPublicClusterView(cluster),
          clusters: db.clusters.map(buildPublicClusterView)
        });
      }

      // 6. POST /api/faces/search
      //    Supports:
      //     - Selfie / Reference image (queryImageBase64 -> SCRFD + ArcFace 512-D on server)
      //     - Tap-a-Face in Lightbox (sourcePhotoId + sourceFaceIndex)
      //     - Direct descriptors array
      //    Plus Automatic 2-Hop Query Expansion & Optional Gemini AI Borderline Verification!
      if (method === 'POST' && pathname === '/api/faces/search') {
        const searchStartedAt = Date.now();
        const body = await readJsonBody(req);
        const threshold = sanitizeCosineThreshold(body.threshold, config.faceMatchThreshold || DEFAULT_SEARCH_COSINE);
        const engineMode = normalizeEngineMode(body.engineMode || config.searchEngineMode || 'arcface');

        let queryVectors = [];
        let queryFaceAvatarUrl = '';
        let queryImageBase64 = typeof body.queryImageBase64 === 'string' ? body.queryImageBase64 : '';

        // Option A: Tap-a-Face inside an event photo!
        if (body.sourcePhotoId !== undefined && body.sourceFaceIndex !== undefined) {
          const srcPhoto = db.photos.find((p) => p.id === String(body.sourcePhotoId));
          const fIdx = Number(body.sourceFaceIndex);
          const srcFace = srcPhoto && Array.isArray(srcPhoto.faces) ? srcPhoto.faces[fIdx] : null;
          if (!srcFace || !Array.isArray(srcFace.descriptor) || !srcFace.descriptor.length) {
            return sendJson(res, 404, { ok: false, error: 'ไม่พบข้อมูลใบหน้าที่เลือกในรูปนี้' });
          }
          queryVectors = [srcFace.descriptor];
          queryFaceAvatarUrl = srcFace.avatarDataUrl || '';
          if (!queryImageBase64 && queryFaceAvatarUrl) {
            queryImageBase64 = queryFaceAvatarUrl;
          }
        }

        // Option B: Extract 512-D ArcFace vector(s) from uploaded Selfie / Reference image on server!
        if (!queryVectors.length && queryImageBase64 && !options.disableArcFaceAutoStart && arcFaceService.hasModelsOnDisk()) {
          if (queryImageBase64.startsWith('/api/avatars/')) {
            const avBuf = await loadAvatarBufferFromUrl(queryImageBase64);
            if (avBuf) queryImageBase64 = `data:image/jpeg;base64,${avBuf.toString('base64')}`;
          }
          const analyzed = await arcFaceService.analyzeImage({
            imageBase64: queryImageBase64,
            scoreThresh: 0.35, // slightly lower det thresh so angled/close selfies are always caught
            flipAugment: true
          });
          if (!analyzed.faces || analyzed.faces.length === 0) {
            return sendJson(res, 200, {
              ok: true,
              noFaceInQuery: true,
              engineUsed: 'arcface_512d',
              durationMs: Date.now() - searchStartedAt,
              matchCount: 0,
              results: []
            });
          }
          // Use the primary (largest) face in the selfie so friends in background of selfie don't pollute search
          const primaryFace = analyzed.faces[0];
          queryVectors = [primaryFace.descriptor];
          queryFaceAvatarUrl = primaryFace.avatarDataUrl || '';
        }

        // Option C: Fallback to client-provided descriptors (used in unit tests)
        if (!queryVectors.length && Array.isArray(body.descriptors) && body.descriptors.length > 0) {
          queryVectors = body.descriptors;
        }

        if (!queryVectors.length) {
          return sendJson(res, 400, { ok: false, error: 'ไม่พบใบหน้าในภาพที่ใช้ค้นหา กรุณาใช้ภาพที่เห็นใบหน้าชัดเจน' });
        }

        const photoMap = new Map(db.photos.map((p) => [p.id, p]));
        const arcMatches = searchByFaceVectors(db.photos, queryVectors, threshold, { queryExpansion: true });
        const expandedCount = arcMatches.filter((m) => m.expandedMatched).length;

        // Pure ArcFace 512-D Mode (Fastest, Free, High Precision)
        const hasGeminiKey = Boolean(config.geminiApiKey && String(config.geminiApiKey).trim());
        if (engineMode !== 'arcface_gemini' || !hasGeminiKey || !(queryFaceAvatarUrl || queryImageBase64)) {
          const results = arcMatches
            .map((m) => {
              const p = photoMap.get(m.photoId);
              if (!p) return null;
              return {
                ...buildPublicPhotoView(p),
                matchSimilarity: m.similarity,
                cosineScore: m.cosine,
                matchedFaceIndex: m.matchedFaceIndex,
                expandedMatched: Boolean(m.expandedMatched),
                arcfaceVerified: true,
                aiVerified: false
              };
            })
            .filter(Boolean);

          return sendJson(res, 200, {
            ok: true,
            engineUsed: 'arcface_512d',
            threshold,
            expandedCount,
            queryFaceAvatarUrl,
            geminiError: (engineMode === 'arcface_gemini' && !hasGeminiKey)
              ? 'ยังไม่ได้บันทึก Gemini API Key (แสดงผลด้วย ArcFace 512-D)'
              : '',
            durationMs: Date.now() - searchStartedAt,
            matchCount: results.length,
            results
          });
        }

        // Hybrid Mode: ArcFace 512-D + Gemini AI Borderline Verification!
        //  1. High-certainty ArcFace matches (cosine >= highConfCutoff) are kept directly!
        //  2. Borderline candidates (threshold - 0.07 <= cosine < highConfCutoff) are verified by Gemini Vision AI!
        const highConfCutoff = Math.max(threshold + 0.09, 0.47);
        const looseCutoff = Math.max(0.26, threshold - 0.07);
        const wideMatches = searchByFaceVectors(db.photos, queryVectors, looseCutoff, { queryExpansion: true });

        const sureMatches = [];
        const borderlineMatches = [];

        for (const wm of wideMatches) {
          if (wm.cosine >= highConfCutoff) {
            sureMatches.push(wm);
          } else if (borderlineMatches.length < 14) {
            borderlineMatches.push(wm);
          }
        }

        let geminiUsed = false;
        let geminiModelUsed = '';
        let geminiError = '';
        const finalResults = [];

        for (const sm of sureMatches) {
          const p = photoMap.get(sm.photoId);
          if (p) {
            finalResults.push({
              ...buildPublicPhotoView(p),
              matchSimilarity: sm.similarity,
              cosineScore: sm.cosine,
              matchedFaceIndex: sm.matchedFaceIndex,
              arcfaceVerified: true,
              aiVerified: false
            });
          }
        }

        if (borderlineMatches.length > 0) {
          try {
            const candidatePayloads = [];
            for (const bm of borderlineMatches) {
              const p = photoMap.get(bm.photoId);
              if (!p) continue;
              if (bm.avatarDataUrl && bm.avatarDataUrl.startsWith('data:')) {
                candidatePayloads.push({ id: p.id, base64: bm.avatarDataUrl, mimeType: 'image/jpeg' });
              } else if (bm.avatarDataUrl && bm.avatarDataUrl.startsWith('/api/avatars/')) {
                const avBuf = await loadAvatarBufferFromUrl(bm.avatarDataUrl);
                if (avBuf) candidatePayloads.push({ id: p.id, buffer: avBuf, mimeType: 'image/jpeg' });
              } else {
                const buf = await loadThumbBufferForPhoto(p);
                if (buf) candidatePayloads.push({ id: p.id, buffer: buf, mimeType: 'image/jpeg' });
              }
            }

            let resolvedQueryBase64 = queryFaceAvatarUrl || queryImageBase64;
            if (resolvedQueryBase64 && resolvedQueryBase64.startsWith('/api/avatars/')) {
              const qBuf = await loadAvatarBufferFromUrl(resolvedQueryBase64);
              resolvedQueryBase64 = qBuf ? `data:image/jpeg;base64,${qBuf.toString('base64')}` : queryImageBase64;
            }

            if (candidatePayloads.length > 0 && resolvedQueryBase64) {
              const gemRes = await verifyFacesWithGemini({
                apiKey: config.geminiApiKey,
                model: config.geminiModel || DEFAULT_GEMINI_MODEL,
                queryImageBase64: resolvedQueryBase64,
                queryMimeType: 'image/jpeg',
                candidates: candidatePayloads
              });

              if (gemRes.ok) {
                geminiUsed = true;
                geminiModelUsed = gemRes.modelUsed;
                for (const bm of borderlineMatches) {
                  const p = photoMap.get(bm.photoId);
                  const gem = gemRes.matchesMap.get(bm.photoId);
                  if (p && gem && gem.isSamePerson && gem.confidence >= 68) {
                    const blended = Math.round(gem.confidence * 0.6 + bm.similarity * 0.4);
                    finalResults.push({
                      ...buildPublicPhotoView(p),
                      matchSimilarity: Math.min(98, Math.max(bm.similarity, blended)),
                      cosineScore: bm.cosine,
                      matchedFaceIndex: bm.matchedFaceIndex,
                      arcfaceVerified: true,
                      aiVerified: true
                    });
                  }
                }
              }
            }
          } catch (gErr) {
            geminiError = gErr.message || 'Gemini verification error';
            // Fallback: keep standard ArcFace matches >= threshold
            for (const bm of borderlineMatches) {
              if (bm.cosine >= threshold) {
                const p = photoMap.get(bm.photoId);
                if (p) {
                  finalResults.push({
                    ...buildPublicPhotoView(p),
                    matchSimilarity: bm.similarity,
                    cosineScore: bm.cosine,
                    matchedFaceIndex: bm.matchedFaceIndex,
                    arcfaceVerified: true,
                    aiVerified: false
                  });
                }
              }
            }
          }
        } else {
          geminiUsed = true;
          geminiModelUsed = config.geminiModel || DEFAULT_GEMINI_MODEL;
        }

        finalResults.sort((a, b) => (b.matchSimilarity || 0) - (a.matchSimilarity || 0));

        return sendJson(res, 200, {
          ok: true,
          engineUsed: geminiUsed ? 'arcface_gemini' : 'arcface_512d',
          threshold,
          expandedCount,
          queryFaceAvatarUrl,
          geminiUsed,
          geminiModel: geminiModelUsed,
          geminiError,
          durationMs: Date.now() - searchStartedAt,
          matchCount: finalResults.length,
          results: finalResults
        });
      }

      // 7. POST /api/drive/sync (Pulls from Google Drive & immediately indexes with SCRFD + ArcFace 512-D!)
      if (method === 'POST' && pathname === '/api/drive/sync') {
        const folderId = config.driveFolderId || parseDriveFolderId(config.driveFolderUrl);
        if (!folderId) {
          return sendJson(res, 400, {
            ok: false,
            error: 'กรุณาตั้งค่าลิงก์ Google Drive Folder กลางก่อนกดซิงก์'
          });
        }

        let pushedToDrive = 0;
        let pulledFromDrive = 0;
        const newlyPulledPhotos = [];
        const errors = [];

        for (const photo of db.photos) {
          if (!photo.driveSynced && photo.origFileName) {
            const origPath = path.join(originalsDir, photo.origFileName);
            if (fs.existsSync(origPath)) {
              const buf = await fsp.readFile(origPath);
              const upRes = await uploadFileToDrive(config, {
                fileName: photo.name,
                mimeType: photo.mimeType,
                buffer: buf
              });
              if (upRes.synced) {
                photo.driveSynced = true;
                photo.driveFileId = upRes.driveFileId;
                photo.webViewLink = upRes.webViewLink;
                photo.driveSyncNote = '';
                pushedToDrive++;
              }
            }
          }
        }

        try {
          const remoteFiles = await listDriveFolderImages(config);
          const existingDriveIds = new Set(db.photos.map((p) => p.driveFileId).filter(Boolean));
          const existingNames = new Set(db.photos.map((p) => p.name.toLowerCase()));

          for (const rf of remoteFiles) {
            if (!rf.id) continue;
            if (existingDriveIds.has(rf.id) || existingNames.has(String(rf.name || '').toLowerCase())) {
              continue;
            }

            try {
              const imgBuf = await downloadDriveFile(config, rf.id);
              const id = `ph_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
              const rawName = rf.name || `${rf.id}.jpg`;
              const mimeType = rf.mimeType || 'image/jpeg';
              const ext = extFromMimeOrName(mimeType, rawName);
              const origFileName = `${id}${ext}`;
              const thumbFileName = `${id}_thumb.jpg`;

              await fsp.writeFile(path.join(originalsDir, origFileName), imgBuf);
              await fsp.writeFile(path.join(thumbsDir, thumbFileName), imgBuf);

              const newPhoto = {
                id,
                name: rawName,
                mimeType,
                size: imgBuf.length,
                width: 0,
                height: 0,
                source: 'google_drive_sync',
                createdAt: rf.createdTime || new Date().toISOString(),
                origFileName,
                thumbFileName,
                driveFileId: rf.id,
                driveSynced: true,
                driveSyncNote: 'ซิงก์จาก Google Drive Folder กลาง',
                webViewLink: rf.webViewLink || `https://drive.google.com/file/d/${rf.id}/view`,
                faceIndexed: false,
                faces: [],
                clusterIds: []
              };

              db.photos.unshift(newPhoto);
              newlyPulledPhotos.push(newPhoto);
              existingDriveIds.add(rf.id);
              pulledFromDrive++;
            } catch (dlErr) {
              errors.push(`${rf.name || rf.id}: ${dlErr.message}`);
            }
          }
        } catch (listErr) {
          errors.push(listErr.message);
        }

        if (newlyPulledPhotos.length > 0 && !options.disableArcFaceAutoStart && arcFaceService.hasModelsOnDisk()) {
          await indexPhotosWithArcFace(newlyPulledPhotos);
        } else {
          saveDb();
        }

        return sendJson(res, 200, {
          ok: true,
          pushedToDrive,
          pulledFromDrive,
          errors,
          photos: db.photos.map(buildPublicPhotoView),
          clusters: db.clusters.map(buildPublicClusterView),
          stats: getStats()
        });
      }

      // 8a. GET /api/avatars/:file (Immutable Edge-Cached Face Avatars)
      const avatarMatch = pathname.match(/^\/api\/avatars\/([a-zA-Z0-9_.-]+)$/);
      if (method === 'GET' && avatarMatch) {
        const safeName = path.basename(avatarMatch[1]);
        const avPath = path.join(avatarsDir, safeName);
        if (streamFileWithCache(req, res, avPath, 'image/jpeg')) {
          return;
        }
        res.writeHead(404);
        return res.end('Not found');
      }

      // 8. GET /api/photos/:id/(thumb|preview|file) — Streamed with ETag + Immutable Cache
      const fileRouteMatch = pathname.match(/^\/api\/photos\/([a-zA-Z0-9_-]+)\/(thumb|preview|file)$/);
      if (method === 'GET' && fileRouteMatch) {
        const photoId = fileRouteMatch[1];
        const kind = fileRouteMatch[2];
        const photo = db.photos.find((p) => p.id === photoId);
        if (!photo) {
          res.writeHead(404);
          return res.end('Not found');
        }

        const origPath = path.join(originalsDir, photo.origFileName || '');
        const thumbPath = path.join(thumbsDir, photo.thumbFileName || photo.origFileName || '');
        const previewFileName = photo.previewFileName || `${photo.id}_preview.jpg`;
        const previewPath = path.join(previewsDir, previewFileName);

        let targetPath = origPath;
        if (kind === 'thumb') {
          targetPath = fs.existsSync(thumbPath) ? thumbPath : origPath;
        } else if (kind === 'preview') {
          if (!fs.existsSync(previewPath) && fs.existsSync(origPath) && !options.disableArcFaceAutoStart && arcFaceService.hasModelsOnDisk()) {
            try {
              await arcFaceService.generatePreview({ imagePath: origPath, savePreviewPath: previewPath });
              photo.previewFileName = previewFileName;
            } catch {
              // fallback to origPath or thumbPath below
            }
          }
          targetPath = fs.existsSync(previewPath) ? previewPath : (fs.existsSync(origPath) ? origPath : thumbPath);
        }

        if (!fs.existsSync(targetPath) && photo.driveFileId) {
          const dlBuf = await downloadDriveFile(config, photo.driveFileId);
          await fsp.writeFile(origPath, dlBuf);
          targetPath = origPath;
        }

        const contentType = (kind === 'thumb' || (kind === 'preview' && targetPath === previewPath))
          ? 'image/jpeg'
          : (photo.mimeType || 'image/jpeg');
        const downloadName = reqUrl.searchParams.get('download') === '1' ? (photo.name || `${photo.id}.jpg`) : '';

        if (streamFileWithCache(req, res, targetPath, contentType, { downloadName })) {
          return;
        }
        res.writeHead(404);
        return res.end('File missing');
      }

      // 9. POST or GET /api/photos/download-zip (Capped at MAX_ZIP_PHOTOS = 40 to protect RAM)
      if ((method === 'POST' || method === 'GET') && pathname === '/api/photos/download-zip') {
        const MAX_ZIP_PHOTOS = 40;
        let ids = [];
        if (method === 'GET') {
          const rawIds = reqUrl.searchParams.get('ids') || '';
          ids = rawIds.split(',').map((s) => s.trim()).filter(Boolean);
        } else {
          const body = await readJsonBody(req);
          ids = Array.isArray(body.ids) ? body.ids : [];
        }

        const selectedPhotos = (ids.length
          ? db.photos.filter((p) => ids.includes(p.id))
          : db.photos
        ).slice(0, MAX_ZIP_PHOTOS);

        if (!selectedPhotos.length) {
          return sendJson(res, 400, { ok: false, error: 'ไม่มีรูปภาพที่เลือกสำหรับดาวน์โหลด ZIP' });
        }

        const zipEntries = [];
        for (const photo of selectedPhotos) {
          const origPath = path.join(originalsDir, photo.origFileName);
          let buf = null;
          if (fs.existsSync(origPath)) {
            buf = await fsp.readFile(origPath);
          } else if (photo.driveFileId) {
            try {
              buf = await downloadDriveFile(config, photo.driveFileId);
            } catch {
              buf = null;
            }
          }
          if (buf) {
            zipEntries.push({
              name: photo.name || `${photo.id}.jpg`,
              buffer: buf,
              date: photo.createdAt ? new Date(photo.createdAt) : new Date()
            });
          }
        }

        const zipBuf = createZipBuffer(zipEntries);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="RM6-Pink-Album-Photos.zip"',
          'Content-Length': String(zipBuf.length)
        });
        return res.end(zipBuf);
      }

      // 10. DELETE /api/photos/:id (Admin only; non-admin requests receive 403)
      const deleteMatch = pathname.match(/^\/api\/photos\/([a-zA-Z0-9_-]+)$/);
      if (method === 'DELETE' && deleteMatch) {
        if (!isAdminAuthorized(req)) {
          return sendJson(res, 403, { ok: false, error: 'ไม่อนุญาตให้ลบรูปภาพออกจากระบบ (เฉพาะผู้ดูแลระบบ)' });
        }
        const photoId = deleteMatch[1];
        const idx = db.photos.findIndex((p) => p.id === photoId);
        if (idx === -1) {
          return sendJson(res, 404, { ok: false, error: 'ไม่พบรูปภาพนี้' });
        }
        const [removed] = db.photos.splice(idx, 1);
        if (removed.origFileName) {
          await fsp.unlink(path.join(originalsDir, removed.origFileName)).catch(() => {});
        }
        if (removed.thumbFileName) {
          await fsp.unlink(path.join(thumbsDir, removed.thumbFileName)).catch(() => {});
        }
        if (removed.previewFileName) {
          await fsp.unlink(path.join(previewsDir, removed.previewFileName)).catch(() => {});
        }
        db.clusters = recomputeClusters(db.photos, db.clusters, config.clusterThreshold || DEFAULT_CLUSTER_COSINE);
        saveDb();
        return sendJson(res, 200, {
          ok: true,
          clusters: db.clusters.map(buildPublicClusterView),
          stats: getStats()
        });
      }

      // 11. Static files in public/ (Cached + Gzipped for fast Cloudflare / Mobile load)
      if (method === 'GET') {
        const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        const safePath = path.normalize(path.join(publicDir, relPath));
        if (safePath.startsWith(publicDir) && fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
          const ct = mimeFromExt(safePath);
          if (ct.startsWith('text/') || ct.includes('javascript')) {
            const raw = await fsp.readFile(safePath);
            const hdrs = { 'Content-Type': ct, 'Cache-Control': 'public, max-age=300' };
            if (raw.length > 512 && currentAcceptEncoding.includes('gzip')) {
              const gz = zlib.gzipSync(raw, { level: zlib.constants.Z_BEST_SPEED });
              hdrs['Content-Encoding'] = 'gzip';
              hdrs['Content-Length'] = String(gz.length);
              res.writeHead(200, hdrs);
              return res.end(gz);
            }
            hdrs['Content-Length'] = String(raw.length);
            res.writeHead(200, hdrs);
            return res.end(raw);
          }
          streamFileWithCache(req, res, safePath, ct, { cacheControl: 'public, max-age=86400' });
          return;
        }
      }

      sendJson(res, 404, { ok: false, error: `ไม่พบเส้นทาง ${method} ${pathname}` });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message || 'Internal Server Error' });
    }
  });

  server.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer);
    if (reclusterTimer) {
      clearTimeout(reclusterTimer);
      reclusterTimer = null;
    }
    arcFaceService.shutdown();
  });

  return { server, arcFaceService, indexPhotosWithArcFace, getConfig: () => config, getDb: () => db };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { server } = createAppServer();
  server.listen(port, () => {
    console.log(`🌸 RM6 Pink Album (InsightFace ArcFace 512-D) running at http://localhost:${port}`);
    console.log(`📱 LAN URL for mobile QR sharing: ${getLanOrigin(port)}`);
  });
}

module.exports = { createAppServer };
