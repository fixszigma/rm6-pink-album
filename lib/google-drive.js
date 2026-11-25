'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

/**
 * Google Drive Shared Folder Connector
 * - Supports Owner OAuth2 Refresh Token (works with personal @gmail.com Drive storage quota!)
 * - Supports Service Account JSON (works for reading shared folders & uploading to Google Workspace Shared Drives)
 * - Supports API Key / Public Folder fallback for read-only syncing
 */

function parseDriveFolderId(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';

  const folderMatch = raw.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
  if (folderMatch) return folderMatch[1];

  const idParamMatch = raw.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (idParamMatch) return idParamMatch[1];

  if (/^[a-zA-Z0-9_-]{10,}$/.test(raw)) {
    return raw;
  }

  return '';
}

function buildDriveFolderWebUrl(folderId) {
  if (!folderId) return '';
  return `https://drive.google.com/drive/folders/${folderId}`;
}

let cachedServiceToken = { token: '', expiresAt: 0, cacheKey: '' };
let cachedOAuthToken = { token: '', expiresAt: 0, cacheKey: '' };

function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function loadServiceAccountObject(config) {
  if (config.serviceAccountJson && typeof config.serviceAccountJson === 'object') {
    return config.serviceAccountJson;
  }
  if (typeof config.serviceAccountJson === 'string' && config.serviceAccountJson.trim().startsWith('{')) {
    try {
      return JSON.parse(config.serviceAccountJson.trim());
    } catch {
      return null;
    }
  }
  if (config.serviceAccountFile && fs.existsSync(config.serviceAccountFile)) {
    try {
      return JSON.parse(fs.readFileSync(config.serviceAccountFile, 'utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

function buildGoogleOAuthUrl(config, redirectUri) {
  const clientId = String(config.oauthClientId || '').trim();
  if (!clientId) {
    throw new Error('กรุณากรอก Google OAuth Client ID ก่อนเชื่อมต่อ');
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive',
    access_type: 'offline',
    prompt: 'consent'
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeOAuthCode(config, code, redirectUri) {
  const clientId = String(config.oauthClientId || '').trim();
  const clientSecret = String(config.oauthClientSecret || '').trim();
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  });

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`แลก OAuth Token ไม่สำเร็จ (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  return {
    accessToken: data.access_token || '',
    refreshToken: data.refresh_token || '',
    expiresIn: Number(data.expires_in) || 3600
  };
}

async function getOAuthRefreshAccessToken(config) {
  const clientId = String(config.oauthClientId || '').trim();
  const clientSecret = String(config.oauthClientSecret || '').trim();
  const refreshToken = String(config.oauthRefreshToken || '').trim();
  if (!clientId || !clientSecret || !refreshToken) return '';

  const nowSec = Math.floor(Date.now() / 1000);
  const cacheKey = `${clientId}:${refreshToken.slice(-8)}`;
  if (
    cachedOAuthToken.token &&
    cachedOAuthToken.cacheKey === cacheKey &&
    cachedOAuthToken.expiresAt - 60 > nowSec
  ) {
    return cachedOAuthToken.token;
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`ต่ออายุ Google OAuth Token ไม่สำเร็จ (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  cachedOAuthToken = {
    token: data.access_token || '',
    expiresAt: nowSec + (Number(data.expires_in) || 3600),
    cacheKey
  };
  return cachedOAuthToken.token;
}

async function getDriveAccessToken(config, { preferWriteOwner = false } = {}) {
  // 1. Prefer Owner OAuth Refresh Token (has real storage quota for uploading to personal @gmail Drive!)
  if (config.oauthRefreshToken && config.oauthClientId && config.oauthClientSecret) {
    const refreshed = await getOAuthRefreshAccessToken(config);
    if (refreshed) return refreshed;
  }

  // 2. Explicit static OAuth token
  if (config.googleOauthToken && String(config.googleOauthToken).trim()) {
    return String(config.googleOauthToken).trim();
  }

  // 3. Service Account JWT
  const sa = loadServiceAccountObject(config);
  if (!sa || !sa.client_email || !sa.private_key) {
    return '';
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const cacheKey = `${sa.client_email}:${sa.private_key_id || ''}`;
  if (
    cachedServiceToken.token &&
    cachedServiceToken.cacheKey === cacheKey &&
    cachedServiceToken.expiresAt - 60 > nowSec
  ) {
    return cachedServiceToken.token;
  }

  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: tokenUri,
    iat: nowSec,
    exp: nowSec + 3600
  };

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(sa.private_key);
  const assertion = `${signingInput}.${base64UrlEncode(signature)}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion
  });

  const resp = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Google Service Account auth failed (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  cachedServiceToken = {
    token: data.access_token || '',
    expiresAt: nowSec + (Number(data.expires_in) || 3600),
    cacheKey
  };
  return cachedServiceToken.token;
}

function getDriveAuthMode(config) {
  const folderId = config.driveFolderId || parseDriveFolderId(config.driveFolderUrl);
  if (config.oauthRefreshToken && config.oauthClientId && config.oauthClientSecret) {
    return 'oauth_owner';
  }
  if (config.googleOauthToken && String(config.googleOauthToken).trim()) return 'oauth_token';
  const sa = loadServiceAccountObject(config);
  if (sa && sa.client_email && sa.private_key) return 'service_account';
  if (config.googleApiKey && String(config.googleApiKey).trim()) return 'api_key';
  if (folderId) return 'folder_link_only';
  return 'local_only';
}

async function uploadFileToDrive(config, { fileName, mimeType = 'image/jpeg', buffer }) {
  const folderId = config.driveFolderId || parseDriveFolderId(config.driveFolderUrl);
  if (!folderId) {
    return { synced: false, reason: 'ยังไม่ได้ตั้งค่า Google Drive Folder ID' };
  }

  let accessToken = '';
  try {
    accessToken = await getDriveAccessToken(config, { preferWriteOwner: true });
  } catch (err) {
    return { synced: false, reason: err.message };
  }

  if (!accessToken) {
    return {
      synced: false,
      reason: 'บันทึกในเครื่องเรียบร้อย (รอเชื่อมบัญชี Google เพื่ออัปโหลดเข้า Google Drive)'
    };
  }

  const boundary = `rm6pink_${crypto.randomBytes(12).toString('hex')}`;
  const metadata = {
    name: fileName,
    parents: [folderId]
  };

  const preamble = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`,
    'utf8'
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const multipartBody = Buffer.concat([preamble, buffer, epilogue]);

  const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,webViewLink,webContentLink,thumbnailLink';
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': String(multipartBody.length)
    },
    body: multipartBody
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    if (/storageQuotaExceeded/i.test(errText)) {
      return {
        synced: false,
        quotaBlocked: true,
        reason: 'Service Account ไม่มีโควตาอัปโหลดเข้า Google Drive ส่วนตัว (ดึงรูปจาก Drive ได้ปกติ — หากต้องการส่งรูปจากเว็บขึ้น Drive ให้เชื่อม OAuth เจ้าของในหน้าตั้งค่า)'
      };
    }
    return { synced: false, reason: `Google Drive upload error (${resp.status}): ${errText.slice(0, 180)}` };
  }

  const data = await resp.json();
  return {
    synced: true,
    driveFileId: data.id,
    webViewLink: data.webViewLink || `https://drive.google.com/file/d/${data.id}/view`,
    webContentLink: data.webContentLink || `https://drive.google.com/uc?export=download&id=${data.id}`,
    thumbnailLink: data.thumbnailLink || ''
  };
}

async function listDriveFolderImages(config) {
  const folderId = config.driveFolderId || parseDriveFolderId(config.driveFolderUrl);
  if (!folderId) {
    throw new Error('กรุณาตั้งค่าลิงก์ Google Drive Folder กลางก่อนซิงก์');
  }

  let accessToken = '';
  try {
    accessToken = await getDriveAccessToken(config);
  } catch {
    accessToken = '';
  }

  const apiKey = String(config.googleApiKey || '').trim();

  if (accessToken || apiKey) {
    const query = `'${folderId}' in parents and trashed = false and mimeType contains 'image/'`;
    const params = new URLSearchParams({
      q: query,
      pageSize: '300',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      fields: 'files(id,name,mimeType,size,createdTime,webViewLink,webContentLink,thumbnailLink)',
      orderBy: 'createdTime desc'
    });
    if (!accessToken && apiKey) {
      params.set('key', apiKey);
    }

    const headers = {};
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }

    const resp = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, { headers });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`ไม่สามารถดึงรายการไฟล์จาก Google Drive API (${resp.status}): ${errText.slice(0, 180)}`);
    }
    const data = await resp.json();
    return Array.isArray(data.files) ? data.files : [];
  }

  const embedUrl = `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}#list`;
  const resp = await fetch(embedUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (RM6PinkAlbum/1.0)' }
  });
  if (!resp.ok) {
    throw new Error(`ไม่สามารถเปิดโฟลเดอร์สาธารณะของ Google Drive (${resp.status})`);
  }
  const html = await resp.text();
  const entries = [];
  const entryRegex = /id="entry-([a-zA-Z0-9_-]{15,})"[\s\S]*?<div class="flip-entry-title">([^<]+)<\/div>/g;
  let match;
  while ((match = entryRegex.exec(html)) !== null) {
    const id = match[1];
    const name = match[2].trim();
    if (/\.(jpe?g|png|webp|gif|heic|bmp)$/i.test(name)) {
      entries.push({
        id,
        name,
        mimeType: name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
        webViewLink: `https://drive.google.com/file/d/${id}/view`,
        webContentLink: `https://drive.google.com/uc?export=download&id=${id}`,
        thumbnailLink: `https://drive.google.com/thumbnail?id=${id}&sz=w800`
      });
    }
  }
  return entries;
}

async function downloadDriveFile(config, driveFileId) {
  let accessToken = '';
  try {
    accessToken = await getDriveAccessToken(config);
  } catch {
    accessToken = '';
  }
  const apiKey = String(config.googleApiKey || '').trim();

  if (accessToken || apiKey) {
    const params = new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' });
    if (!accessToken && apiKey) params.set('key', apiKey);
    const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
    const apiResp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveFileId)}?${params.toString()}`,
      { headers }
    );
    if (apiResp.ok) {
      const arrBuf = await apiResp.arrayBuffer();
      return Buffer.from(arrBuf);
    }
  }

  const publicUrls = [
    `https://drive.google.com/uc?export=download&id=${encodeURIComponent(driveFileId)}`,
    `https://drive.google.com/thumbnail?id=${encodeURIComponent(driveFileId)}&sz=w1600`
  ];

  for (const url of publicUrls) {
    const resp = await fetch(url);
    if (resp.ok) {
      const contentType = resp.headers.get('content-type') || '';
      if (contentType.startsWith('image/') || contentType.includes('octet-stream')) {
        const arrBuf = await resp.arrayBuffer();
        return Buffer.from(arrBuf);
      }
    }
  }

  throw new Error(`ไม่สามารถดาวน์โหลดไฟล์รูป (${driveFileId}) จาก Google Drive ได้`);
}

module.exports = {
  parseDriveFolderId,
  buildDriveFolderWebUrl,
  buildGoogleOAuthUrl,
  exchangeOAuthCode,
  getDriveAuthMode,
  uploadFileToDrive,
  listDriveFolderImages,
  downloadDriveFile
};
