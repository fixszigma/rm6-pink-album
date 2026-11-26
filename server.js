'use strict';

const http = require('node:http');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

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
  const publicDir = path.join(rootDir, 'public');

  const configPath = path.join(dataDir, 'config.json');
  const indexPath = path.join(dataDir, 'index.json');

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(originalsDir, { recursive: true });
  fs.mkdirSync(thumbsDir, { recursive: true });

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
    enableGeminiAi: process.env.ENABLE_GEMINI_AI === 'true',
    searchEngineMode: normalizeEngineMode(process.env.SEARCH_ENGINE_MODE || 'arcface'),
    geminiModel: normalizeModelName(process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL),
    faceMatchThreshold: sanitizeCosineThreshold(process.env.FACE_MATCH_THRESHOLD, DEFAULT_SEARCH_COSINE),
    clusterThreshold: DEFAULT_CLUSTER_COSINE
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

  if (fs.existsSync(indexPath)) {
    try {
      const savedDb = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      db.photos = Array.isArray(savedDb.photos) ? savedDb.photos : [];
      db.clusters = Array.isArray(savedDb.clusters) ? savedDb.clusters : [];
      db.clusters = recomputeClusters(db.photos, db.clusters, config.clusterThreshold || DEFAULT_CLUSTER_COSINE);
    } catch {
      // keep empty db
    }
  }

  function saveConfig() {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  }

  function saveDb() {
    db.updatedAt = new Date().toISOString();
    fs.writeFileSync(indexPath, JSON.stringify(db, null, 2), 'utf8');
  }

  function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(body);
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

  function buildPublicPhotoView(photo) {
    return {
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
      fileUrl: `/api/photos/${photo.id}/file`,
      downloadUrl: `/api/photos/${photo.id}/file?download=1`,
      faceIndexed: Boolean(photo.faceIndexed),
      needsFaceIndex: !photo.faceIndexed,
      faceCount: Array.isArray(photo.faces) ? photo.faces.length : 0,
      clusterIds: Array.isArray(photo.clusterIds) ? photo.clusterIds : [],
      faces: (photo.faces || []).map((f, idx) => ({
        index: idx,
        box: f.box || null,
        detScore: f.detScore || 0,
        clusterEligible: f.clusterEligible !== false,
        clusterId: f.clusterId || null,
        avatarDataUrl: f.avatarDataUrl || ''
      }))
    };
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
        p.thumbFileName = thumbFileName;
        batchItems.push({
          id: p.id,
          imagePath: origPath,
          saveThumbPath: path.join(thumbsDir, thumbFileName)
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
        photo.faces = (r.faces || []).map((f) => ({
          descriptor: normalizeVector(f.descriptor),
          box: f.box,
          detScore: f.detScore,
          blurScore: f.blurScore,
          clusterEligible: f.clusterEligible !== false,
          avatarDataUrl: f.avatarDataUrl || ''
        }));
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
          albumTitle: config.albumTitle,
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
          searchEngineMode: config.searchEngineMode || 'arcface',
          geminiModel: config.geminiModel || DEFAULT_GEMINI_MODEL,
          faceMatchThreshold: config.faceMatchThreshold,
          lanUrl: getLanOrigin(activePort),
          stats: getStats()
        });
      }

      // 2. POST /api/config
      if (method === 'POST' && pathname === '/api/config') {
        const body = await readJsonBody(req);
        if (typeof body.albumTitle === 'string' && body.albumTitle.trim()) {
          config.albumTitle = body.albumTitle.trim();
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
          albumTitle: config.albumTitle,
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

      // 3. GET /api/photos
      if (method === 'GET' && pathname === '/api/photos') {
        const clusterFilter = reqUrl.searchParams.get('clusterId') || '';
        let list = db.photos;
        if (clusterFilter) {
          list = list.filter((p) => Array.isArray(p.clusterIds) && p.clusterIds.includes(clusterFilter));
        }
        return sendJson(res, 200, {
          ok: true,
          photos: list.map(buildPublicPhotoView),
          clusters: db.clusters.map(buildPublicClusterView),
          stats: getStats()
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

      // 4. POST /api/photos/upload (Server-Side SCRFD + ArcFace 512-D Indexing!)
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
          const origFullPath = path.join(originalsDir, origFileName);
          const thumbFullPath = path.join(thumbsDir, thumbFileName);

          await fsp.writeFile(origFullPath, origBuf);
          await fsp.writeFile(thumbFullPath, thumbBuf);

          const driveRes = await uploadFileToDrive(config, {
            fileName: rawName,
            mimeType,
            buffer: origBuf
          });

          let normalizedFaces = [];
          let width = Number(item.width) || 0;
          let height = Number(item.height) || 0;
          let faceIndexed = false;

          if (useServerArcFace) {
            const analyzed = await arcFaceService.analyzeImage({
              imagePath: origFullPath,
              saveThumbPath: item.thumbBase64 ? undefined : thumbFullPath,
              scoreThresh: 0.45,
              flipAugment: true
            });
            width = analyzed.width || width;
            height = analyzed.height || height;
            normalizedFaces = (analyzed.faces || []).map((f) => ({
              descriptor: normalizeVector(f.descriptor),
              box: f.box,
              detScore: f.detScore,
              blurScore: f.blurScore,
              clusterEligible: f.clusterEligible !== false,
              avatarDataUrl: f.avatarDataUrl || ''
            }));
            faceIndexed = true;
          } else if (Array.isArray(item.faces)) {
            normalizedFaces = item.faces
              .map((f) => ({
                descriptor: normalizeVector(f.descriptor),
                box: f.box || null,
                detScore: f.detScore || 0.9,
                clusterEligible: f.clusterEligible !== false,
                avatarDataUrl: f.avatarDataUrl || ''
              }))
              .filter((f) => f.descriptor.length > 0);
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
            driveFileId: driveRes.driveFileId || '',
            driveSynced: Boolean(driveRes.synced),
            driveSyncNote: driveRes.reason || '',
            webViewLink: driveRes.webViewLink || '',
            faceIndexed,
            engineVersion: useServerArcFace ? 'arcface_512d' : 'custom',
            faces: normalizedFaces,
            clusterIds: []
          };

          db.photos.unshift(photoRecord);
          addedPhotos.push(photoRecord);
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
              if (bm.avatarDataUrl) {
                candidatePayloads.push({ id: p.id, base64: bm.avatarDataUrl, mimeType: 'image/jpeg' });
              } else {
                const buf = await loadThumbBufferForPhoto(p);
                if (buf) candidatePayloads.push({ id: p.id, buffer: buf, mimeType: 'image/jpeg' });
              }
            }

            if (candidatePayloads.length > 0) {
              const gemRes = await verifyFacesWithGemini({
                apiKey: config.geminiApiKey,
                model: config.geminiModel || DEFAULT_GEMINI_MODEL,
                queryImageBase64: queryFaceAvatarUrl || queryImageBase64,
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

      // 8. GET /api/photos/:id/thumb & GET /api/photos/:id/file
      const fileRouteMatch = pathname.match(/^\/api\/photos\/([a-zA-Z0-9_-]+)\/(thumb|file)$/);
      if (method === 'GET' && fileRouteMatch) {
        const photoId = fileRouteMatch[1];
        const kind = fileRouteMatch[2];
        const photo = db.photos.find((p) => p.id === photoId);
        if (!photo) {
          res.writeHead(404);
          return res.end('Not found');
        }

        const targetPath = kind === 'thumb'
          ? path.join(thumbsDir, photo.thumbFileName || photo.origFileName)
          : path.join(originalsDir, photo.origFileName);

        let fileBuf = null;
        if (fs.existsSync(targetPath)) {
          fileBuf = await fsp.readFile(targetPath);
        } else if (photo.driveFileId) {
          fileBuf = await downloadDriveFile(config, photo.driveFileId);
          await fsp.writeFile(targetPath, fileBuf);
        }

        if (!fileBuf) {
          res.writeHead(404);
          return res.end('File missing');
        }

        const headers = {
          'Content-Type': kind === 'thumb' ? 'image/jpeg' : (photo.mimeType || 'image/jpeg'),
          'Content-Length': String(fileBuf.length),
          'Cache-Control': 'public, max-age=3600'
        };

        if (reqUrl.searchParams.get('download') === '1') {
          const encodedName = encodeURIComponent(photo.name || `${photo.id}.jpg`);
          headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodedName}`;
        }

        res.writeHead(200, headers);
        return res.end(fileBuf);
      }

      // 9. POST or GET /api/photos/download-zip
      if ((method === 'POST' || method === 'GET') && pathname === '/api/photos/download-zip') {
        let ids = [];
        if (method === 'GET') {
          const rawIds = reqUrl.searchParams.get('ids') || '';
          ids = rawIds.split(',').map((s) => s.trim()).filter(Boolean);
        } else {
          const body = await readJsonBody(req);
          ids = Array.isArray(body.ids) ? body.ids : [];
        }

        const selectedPhotos = ids.length
          ? db.photos.filter((p) => ids.includes(p.id))
          : db.photos;

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

      // 10. DELETE /api/photos/:id
      const deleteMatch = pathname.match(/^\/api\/photos\/([a-zA-Z0-9_-]+)$/);
      if (method === 'DELETE' && deleteMatch) {
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
        db.clusters = recomputeClusters(db.photos, db.clusters, config.clusterThreshold || DEFAULT_CLUSTER_COSINE);
        saveDb();
        return sendJson(res, 200, {
          ok: true,
          clusters: db.clusters.map(buildPublicClusterView),
          stats: getStats()
        });
      }

      // 11. Static files in public/
      if (method === 'GET') {
        const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        const safePath = path.normalize(path.join(publicDir, relPath));
        if (safePath.startsWith(publicDir) && fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
          const content = await fsp.readFile(safePath);
          res.writeHead(200, { 'Content-Type': mimeFromExt(safePath) });
          return res.end(content);
        }
      }

      sendJson(res, 404, { ok: false, error: `ไม่พบเส้นทาง ${method} ${pathname}` });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message || 'Internal Server Error' });
    }
  });

  server.on('close', () => {
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
