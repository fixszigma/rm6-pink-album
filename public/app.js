'use strict';

/**
 * RM6 Pink Album — Client (Attendee-first, server-side InsightFace ArcFace 512-D)
 * - All face detection / embedding happens on the server (SCRFD + ArcFace), so phones just upload / search.
 * - Modes: "arcface" (default) and "arcface_gemini" (Gemini verifies borderline cases).
 * - Tap-a-Face in lightbox to search everything of that person.
 */

const state = {
  activeTab: 'landing',
  albumTitle: 'RM6 Pink Album',
  eventLogoDataUrl: '',
  pendingLogoDataUrl: undefined,
  bankLogoDataUrl: '',
  pendingBankLogoDataUrl: undefined,
  landingTitle1: '',
  landingTitle2: '',
  landingLocation1: '',
  landingLocation2: '',
  landingDate: '',
  landingBgGradient: 'gsb_pink',
  landingBgImageUrl: '',
  pendingLandingBgImageUrl: undefined,
  landingExpireDays: 5,
  similarCandidates: [],
  showFaceBoxes: true,
  extraFriends: [], // [{ key, label, avatarUrl, photoIds: Set<string> }] max 2 extra (= 3 people total)
  selfieCaptureTarget: 'primary', // 'primary' | 'friend'
  driveFolderId: '',
  driveFolderUrl: '',
  driveAuthMode: 'local_only',
  oauthClientId: '',
  hasOauthOwner: false,
  hasGeminiKey: false,
  searchEngineMode: 'arcface_gemini', // 'arcface' | 'arcface_gemini'
  lanUrl: window.location.origin,
  photos: [],
  clusters: [],
  visiblePageLimit: 40,
  selectedPhotoIds: new Set(),
  showAllClusters: false,
  activeClusterId: null,
  searchMatches: null,
  lastQuery: null, // { type: 'image'|'face', queryImageBase64?, sourcePhotoId?, sourceFaceIndex?, avatarUrl }
  lastSearchMeta: null,
  selfieStream: null,
  currentLightboxPhoto: null
};

const $ = (id) => document.getElementById(id);

// ============================================================================
// Styled Toast & Dialog Pop-ups (replaces native alert/confirm)
// ============================================================================

function showAppToast(message, durationMs = 2600) {
  const wrap = $('appToastWrap');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'app-toast';
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => { el.remove(); }, durationMs);
}

function showAppDialog({ title = 'แจ้งเตือน', message = '', icon = '✨', confirmMode = false, okText = 'ตกลง', cancelText = 'ยกเลิก' } = {}) {
  return new Promise((resolve) => {
    const modal = $('appDialogModal');
    if (!modal) { resolve(true); return; }
    $('appDialogIcon').textContent = icon;
    $('appDialogTitle').textContent = title;
    $('appDialogMsg').textContent = message;
    const okBtn = $('btnAppDialogOk');
    const cancelBtn = $('btnAppDialogCancel');
    okBtn.textContent = okText;
    cancelBtn.textContent = cancelText;
    cancelBtn.hidden = !confirmMode;
    modal.hidden = false;

    const cleanup = (val) => {
      modal.hidden = true;
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      resolve(val);
    };
    okBtn.onclick = () => cleanup(true);
    cancelBtn.onclick = () => cleanup(false);
  });
}

function showAppAlert(message, opts = {}) {
  const isErr = /ไม่สำเร็จ|ไม่ถูกต้อง|ไม่พบ|เกิน|ข้อผิดพลาด|❌|⚠️/.test(String(message));
  return showAppDialog({
    title: opts.title || (isErr ? 'แจ้งเตือน' : 'ดำเนินการสำเร็จ'),
    message: String(message || ''),
    icon: opts.icon || (isErr ? '⚠️' : '✅'),
    confirmMode: false
  });
}

function showAppConfirm(message, opts = {}) {
  return showAppDialog({
    title: opts.title || 'ยืนยันการทำรายการ',
    message: String(message || ''),
    icon: opts.icon || '❓',
    confirmMode: true,
    okText: opts.okText || 'ยืนยัน',
    cancelText: opts.cancelText || 'ยกเลิก'
  });
}

// ============================================================================
// Image utilities
// ============================================================================

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error('อ่านไฟล์รูปภาพไม่ได้'));
    if (src instanceof Blob) {
      const url = URL.createObjectURL(src);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.src = url;
    } else {
      img.onload = () => resolve(img);
      img.src = src;
    }
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function downscaleToDataUrl(imgOrCanvas, maxDim = 1024, quality = 0.88) {
  const w = imgOrCanvas.naturalWidth || imgOrCanvas.videoWidth || imgOrCanvas.width;
  const h = imgOrCanvas.naturalHeight || imgOrCanvas.videoHeight || imgOrCanvas.height;
  const scale = Math.min(1, maxDim / Math.max(w, h, 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext('2d').drawImage(imgOrCanvas, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

// ============================================================================
// Rendering
// ============================================================================

function switchTab(tab) {
  state.activeTab = tab === 'upload' ? 'upload' : (tab === 'landing' ? 'landing' : 'search');
  if ($('mainTopbar')) $('mainTopbar').hidden = state.activeTab === 'landing';
  if ($('viewLanding')) $('viewLanding').hidden = state.activeTab !== 'landing';
  $('viewSearch').hidden = state.activeTab !== 'search';
  $('viewUpload').hidden = state.activeTab !== 'upload';
  $('tabBtnSearch').classList.toggle('active', state.activeTab === 'search');
  $('tabBtnUpload').classList.toggle('active', state.activeTab === 'upload');
}

function renderLandingUI() {
  const card = $('viewLanding');
  if (!card) return;
  const grad = state.landingBgGradient || 'gsb_pink';
  card.className = `landing-card landing-bg-${grad}`;
  if (state.landingBgImageUrl) {
    card.style.backgroundImage = `linear-gradient(180deg, rgba(255,255,255,0.74) 0%, rgba(255,255,255,0.58) 50%, rgba(255,255,255,0.78) 100%), url("${state.landingBgImageUrl}")`;
  } else {
    card.style.backgroundImage = '';
  }

  const bankImg = $('landingBankLogoImg');
  const bankFb = $('landingBankLogoFallback');
  if (bankImg && bankFb) {
    if (state.bankLogoDataUrl) {
      bankImg.src = state.bankLogoDataUrl;
      bankImg.hidden = false;
      bankFb.hidden = true;
    } else {
      bankImg.hidden = true;
      bankImg.removeAttribute('src');
      bankFb.hidden = false;
    }
  }

  $('landingTitle1El').textContent = state.landingTitle1 || state.albumTitle || 'RM6 Pink Album';
  const t2 = $('landingTitle2El');
  if (t2) { t2.textContent = state.landingTitle2 || ''; t2.hidden = !state.landingTitle2; }

  const days = Number(state.landingExpireDays);
  const showExpire = Number.isFinite(days) && days > 0;
  if ($('landingExpireBanner')) $('landingExpireBanner').hidden = !showExpire;
  if ($('landingGuideExpireStep')) $('landingGuideExpireStep').hidden = !showExpire;
  if (showExpire) {
    if ($('landingExpireDaysBadge')) $('landingExpireDaysBadge').textContent = String(days);
    if ($('landingGuideDaysSpan')) $('landingGuideDaysSpan').textContent = String(days);
  }

  const setMeta = (wrapId, textId, val) => {
    const w = $(wrapId);
    const t = $(textId);
    if (!w || !t) return false;
    t.textContent = val || '';
    w.hidden = !val;
    return Boolean(val);
  };
  const anyMeta = [
    setMeta('landingLoc1Wrap', 'landingLoc1El', state.landingLocation1),
    setMeta('landingLoc2Wrap', 'landingLoc2El', state.landingLocation2),
    setMeta('landingDateWrap', 'landingDateEl', state.landingDate)
  ].some(Boolean);
  if ($('landingMetaList')) $('landingMetaList').hidden = !anyMeta;
}

function formatDriveStatusText(mode, folderId, stats) {
  if (!folderId) return 'เก็บรูปในเครื่อง (ยังไม่ผูก Google Drive)';
  const synced = stats ? (stats.driveSyncedPhotos || 0) : 0;
  const total = stats ? (stats.totalPhotos || 0) : 0;
  if (mode === 'oauth_owner' || mode === 'oauth_token') {
    return `เชื่อม Google Drive แล้ว (ซิงก์ ${synced}/${total} รูป)`;
  }
  if (mode === 'service_account') {
    return synced < total && total > 0
      ? `ดึงรูปจาก Drive ได้ (ส่งขึ้นค้าง ${total - synced} รูป — เชื่อม OAuth ใน ⚙️)`
      : 'เชื่อม Google Drive แล้ว';
  }
  return 'ผูกโฟลเดอร์ Google Drive แล้ว';
}

function renderBrandLogoUI() {
  const img = $('brandLogoImg');
  const emoji = $('brandLogoEmoji');
  if (!img || !emoji) return;
  if (state.eventLogoDataUrl) {
    img.src = state.eventLogoDataUrl;
    img.hidden = false;
    emoji.hidden = true;
  } else {
    img.hidden = true;
    img.removeAttribute('src');
    emoji.hidden = false;
  }
}

function renderEngineModeUI() {
  const badge = $('geminiBadge');
  if (badge) {
    badge.className = `status-dot ${state.hasGeminiKey ? 'dot-green' : 'dot-yellow'}`;
    badge.title = state.hasGeminiKey ? 'Gemini AI: พร้อมใช้งาน' : 'Gemini AI: ยังไม่ได้ตั้งค่าคีย์';
  }
}

async function fetchStatusAndPhotos() {
  const [statusResp, photosResp] = await Promise.all([
    fetch('/api/status').then((r) => r.json()),
    fetch('/api/photos').then((r) => r.json())
  ]);

  if (statusResp.ok) {
    state.albumTitle = statusResp.albumTitle || 'RM6 Pink Album';
    state.eventLogoDataUrl = statusResp.eventLogoDataUrl || '';
    state.bankLogoDataUrl = statusResp.bankLogoDataUrl || '';
    state.landingTitle1 = statusResp.landingTitle1 || '';
    state.landingTitle2 = statusResp.landingTitle2 || '';
    state.landingLocation1 = statusResp.landingLocation1 || '';
    state.landingLocation2 = statusResp.landingLocation2 || '';
    state.landingDate = statusResp.landingDate || '';
    state.landingBgGradient = statusResp.landingBgGradient || 'gsb_pink';
    state.landingBgImageUrl = statusResp.landingBgImageUrl || '';
    state.landingExpireDays = statusResp.landingExpireDays !== undefined ? Number(statusResp.landingExpireDays) : 5;
    state.driveFolderId = statusResp.driveFolderId || '';
    state.driveFolderUrl = statusResp.driveFolderUrl || '';
    state.driveAuthMode = statusResp.driveAuthMode || 'local_only';
    state.oauthClientId = statusResp.oauthClientId || '';
    state.hasOauthOwner = Boolean(statusResp.hasOauthOwner);
    state.hasGeminiKey = Boolean(statusResp.hasGeminiKey);
    state.searchEngineMode = statusResp.searchEngineMode || 'arcface_gemini';
    const isLocalHost = /^(localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(window.location.hostname);
    state.lanUrl = isLocalHost ? (statusResp.lanUrl || window.location.origin) : window.location.origin;

    $('albumTitleHeading').textContent = state.albumTitle;
    document.title = state.albumTitle;
    renderBrandLogoUI();
    renderLandingUI();
    renderEngineModeUI();

    const aiDot = $('aiEngineStatus');
    if (aiDot) {
      aiDot.className = `status-dot ${statusResp.arcFaceReady ? 'dot-green' : 'dot-yellow'}`;
      aiDot.title = statusResp.arcFaceReady ? 'ระบบตรวจจับใบหน้า: พร้อมใช้งาน' : 'ระบบตรวจจับใบหน้า: ยังไม่พร้อมใช้งาน';
    }

    if (statusResp.faceMatchThreshold && !state.lastQuery) {
      $('thresholdSlider').value = String(statusResp.faceMatchThreshold);
      $('thresholdValueLabel').textContent = Number(statusResp.faceMatchThreshold).toFixed(2);
    }

    const badge = $('driveFolderBadge');
    if (state.driveFolderUrl) { badge.href = state.driveFolderUrl; badge.hidden = false; } else { badge.hidden = true; }
    $('statDriveStatus').textContent = formatDriveStatusText(state.driveAuthMode, state.driveFolderId, statusResp.stats);
  }

  if (photosResp.ok) {
    state.photos = photosResp.photos || [];
    state.clusters = photosResp.clusters || [];
    updateStatsUI(photosResp.stats);
    renderClusters();
    renderPhotoGrid();
  }
}

function updateStatsUI(stats) {
  if (!stats) return;
  const total = stats.totalPhotos || 0;
  $('statTotalPhotos').textContent = total;
  if ($('landingPhotoCountSpan')) $('landingPhotoCountSpan').textContent = total;
  const hogEl = $('statHogStatus');
  if (hogEl) hogEl.textContent = `ArcFace 512-D ${stats.arcfaceFaces || 0}/${stats.totalFaces || 0} ใบหน้า`;
  const btn = $('btnReindexUnindexed');
  const unindexed = stats.unindexedPhotos || 0;
  $('unindexedCountSpan').textContent = unindexed;
  btn.hidden = unindexed === 0;
}

function renderClusters() {
  const section = $('clusterSection');
  const strip = $('clusterStrip');

  if (!state.clusters.length) { section.hidden = true; return; }
  section.hidden = false;

  strip.innerHTML = '';
  const TOP_CLUSTER_LIMIT = 40;
  const multi = state.clusters.filter((c) => c.photoCount >= 2);
  const basePool = multi.length > 0 ? multi : state.clusters;
  const display = state.showAllClusters ? state.clusters : basePool.slice(0, TOP_CLUSTER_LIMIT);
  const hidden = state.clusters.length - display.length;
  $('statTotalClusters').textContent = state.clusters.length;

  for (const cluster of display) {
    const isActive = state.activeClusterId === cluster.id;
    const item = document.createElement('div');
    item.className = `cluster-item${isActive ? ' active' : ''}`;
    item.innerHTML = `
      <div class="cluster-avatar-wrap">
        <img class="cluster-avatar" src="${cluster.avatarDataUrl || ''}" alt="${cluster.label}" />
        <span class="cluster-count-badge">ดูอีก ${cluster.photoCount} ภาพ</span>
      </div>
      <div class="cluster-label" title="คลิกเพื่อกรอง / ดับเบิลคลิกเพื่อเปลี่ยนชื่อ">${cluster.label}</div>
    `;

    // Click a person => filter photos for that person + fetch borderline similar suggestions
    item.addEventListener('click', () => {
      if (state.activeClusterId === cluster.id) { clearAllFilters(); return; }
      state.searchMatches = null;
      state.lastQuery = null;
      state.extraFriends = [];
      state.similarCandidates = [];
      state.visiblePageLimit = 40;
      state.activeClusterId = cluster.id;
      saveGuestAvatar({ type: 'cluster', clusterId: cluster.id, avatarUrl: cluster.avatarDataUrl || '' });
      syncFilterBannerUI();
      renderClusters();
      renderPhotoGrid();
      loadSimilarClustersForActive(cluster.id);
    });

    item.addEventListener('dblclick', async (e) => {
      e.stopPropagation();
      const newName = window.prompt('ตั้งชื่อ:', cluster.label);
      if (newName === null) return;
      const resp = await fetch(`/api/clusters/${encodeURIComponent(cluster.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: newName.trim() })
      }).then((r) => r.json());
      if (resp.ok) {
        state.clusters = resp.clusters || state.clusters;
        syncFilterBannerUI();
        renderClusters();
      }
    });

    strip.appendChild(item);
  }

  if (hidden > 0 || (state.showAllClusters && state.clusters.length > 40)) {
    const more = document.createElement('div');
    more.className = 'cluster-item';
    more.innerHTML = `
      <div class="cluster-avatar-wrap" style="display:flex;align-items:center;justify-content:center;background:var(--pink-50);color:var(--pink-600);font-weight:600;font-size:0.78rem;">
        ${state.showAllClusters ? 'ย่อ' : `+${hidden}`}
      </div>
      <div class="cluster-label">${state.showAllClusters ? 'แสดงเฉพาะพบบ่อย' : 'ดูเพิ่มเติม'}</div>
    `;
    more.addEventListener('click', () => {
      state.showAllClusters = !state.showAllClusters;
      renderClusters();
    });
    strip.appendChild(more);
  }
}

function openAddFriendModal() {
  if ($('friendSelfieStatus')) $('friendSelfieStatus').hidden = true;
  renderFriendPickerModal();
  if ($('addFriendModal')) $('addFriendModal').hidden = false;
}

function renderFriendPickerModal() {
  const grid = $('friendPickerGrid');
  const countEl = $('friendModalCountSpan');
  if (countEl) countEl.textContent = String(1 + state.extraFriends.length);

  const previewWrap = $('friendSelfiePreviewWrap');
  const previewList = $('friendSelfiePreviewList');
  const selfieFriends = state.extraFriends.filter((f) => String(f.key).startsWith('selfie_'));
  if (previewWrap && previewList) {
    previewList.innerHTML = '';
    if (selfieFriends.length > 0) {
      selfieFriends.forEach((sf) => {
        const chip = document.createElement('div');
        chip.className = 'friend-selfie-chip';
        chip.innerHTML = `<img src="${sf.avatarUrl || ''}" alt="${sf.label}" /><span>${sf.label} (${sf.photoIds.size} รูป)</span>`;
        previewList.appendChild(chip);
      });
      previewWrap.hidden = false;
    } else {
      previewWrap.hidden = true;
    }
  }

  if (!grid) return;
  grid.innerHTML = '';

  const candidates = state.clusters.filter((c) => c.id !== state.activeClusterId);
  if (!candidates.length) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--text-muted);font-size:0.82rem;padding:12px;">ยังไม่มีรายชื่อบุคคลอื่นในงาน</div>';
    return;
  }

  candidates.forEach((c) => {
    const existingIdx = state.extraFriends.findIndex((f) => f.key === c.id);
    const picked = existingIdx >= 0;
    const item = document.createElement('div');
    item.className = `friend-picker-item${picked ? ' picked' : ''}`;
    item.innerHTML = `
      <div class="friend-picker-avatar-wrap">
        <img src="${c.avatarDataUrl || ''}" alt="${c.label}" />
        ${picked ? '<span class="friend-picker-check">✓</span>' : ''}
      </div>
      <div class="cluster-label">${c.label}</div>
    `;
    item.addEventListener('click', () => {
      if (picked) {
        state.extraFriends.splice(existingIdx, 1);
      } else {
        if (state.extraFriends.length >= 2) {
          showAppAlert('เพิ่มเพื่อนได้สูงสุด 2 คน (รวมทั้งหมดไม่เกิน 3 คนในรูป)');
          return;
        }
        const matchedIds = new Set(
          state.photos
            .filter((p) => Array.isArray(p.clusterIds) && p.clusterIds.includes(c.id))
            .map((p) => p.id)
        );
        state.extraFriends.push({
          key: c.id,
          label: c.label,
          avatarUrl: c.avatarDataUrl || '',
          photoIds: matchedIds
        });
      }
      renderFriendPickerModal();
      syncFilterBannerUI();
      renderPhotoGrid();
    });
    grid.appendChild(item);
  });
}

async function addFriendFromImageElement(imgOrCanvas) {
  if (state.extraFriends.length >= 2) {
    showAppAlert('เพิ่มเพื่อนได้สูงสุด 2 คน (รวมทั้งหมดไม่เกิน 3 คนในรูป)');
    return;
  }
  const statusEl = $('friendSelfieStatus');
  if (statusEl) {
    statusEl.hidden = false;
    statusEl.textContent = '🔄 กำลังค้นหาใบหน้าเพื่อน...';
  }
  try {
    const queryImageBase64 = downscaleToDataUrl(imgOrCanvas, 1024, 0.9);
    const fallbackAvatar = downscaleToDataUrl(imgOrCanvas, 160, 0.8);
    const resp = await fetch('/api/faces/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        engineMode: currentEngineMode(),
        threshold: Number($('thresholdSlider').value) || 0.38,
        queryImageBase64
      })
    }).then((r) => r.json());

    if (!resp.ok || resp.noFaceInQuery) {
      if (statusEl) statusEl.textContent = resp.noFaceInQuery ? '⚠️ ไม่พบใบหน้าในภาพเพื่อน กรุณาลองใหม่' : (resp.error || 'ค้นหาไม่สำเร็จ');
      return;
    }

    const idx = state.extraFriends.length + 1;
    state.extraFriends.push({
      key: `selfie_${Date.now()}`,
      label: `เพื่อน ${idx}`,
      avatarUrl: resp.queryFaceAvatarUrl || fallbackAvatar,
      photoIds: new Set((resp.results || []).map((r) => r.id))
    });
    if (statusEl) statusEl.hidden = true;
    renderFriendPickerModal();
    syncFilterBannerUI();
    renderPhotoGrid();
  } catch (err) {
    if (statusEl) statusEl.textContent = `❌ ${err.message}`;
  }
}

const USER_FACE_MERGES_KEY = 'rm6_user_face_merges_v1';

function loadUserFaceMerges() {
  try {
    const raw = window.localStorage.getItem(USER_FACE_MERGES_KEY);
    return raw ? JSON.parse(raw) : { confirmed: {}, dismissed: {} };
  } catch {
    return { confirmed: {}, dismissed: {} };
  }
}

function saveUserFaceMerges(obj) {
  try { window.localStorage.setItem(USER_FACE_MERGES_KEY, JSON.stringify(obj)); } catch {}
}

function currentPrimaryMergeKey() {
  if (state.activeClusterId) return `cluster:${state.activeClusterId}`;
  if (Array.isArray(state.searchMatches)) {
    const av = (state.lastSearchMeta && state.lastSearchMeta.queryFaceAvatarUrl) || (state.lastQuery && state.lastQuery.avatarUrl) || 'selfie';
    return `selfie:${av.slice(-40)}`;
  }
  return '';
}

function getConfirmedSimilarClusterIds() {
  const key = currentPrimaryMergeKey();
  if (!key) return [];
  const store = loadUserFaceMerges();
  return Array.isArray(store.confirmed && store.confirmed[key]) ? store.confirmed[key] : [];
}

async function loadSimilarClustersForActive(clusterId) {
  try {
    const resp = await fetch(`/api/clusters/${encodeURIComponent(clusterId)}/similar`).then((r) => r.json());
    if (state.activeClusterId !== clusterId) return;
    state.similarCandidates = (resp && resp.ok && Array.isArray(resp.similar)) ? resp.similar : [];
    renderSimilarFacesUI();
    syncFilterBannerUI();
    renderPhotoGrid();
  } catch {
    state.similarCandidates = [];
    renderSimilarFacesUI();
  }
}

function renderSimilarFacesUI() {
  const box = $('similarFacesBox');
  const listEl = $('similarFacesList');
  if (!box || !listEl) return;

  const key = currentPrimaryMergeKey();
  if (!key) { box.hidden = true; listEl.innerHTML = ''; return; }

  const store = loadUserFaceMerges();
  const confirmedIds = new Set((store.confirmed && store.confirmed[key]) || []);
  const dismissedIds = new Set((store.dismissed && store.dismissed[key]) || []);

  // Include both API candidates + any previously confirmed clusters from state.clusters
  const candidateMap = new Map();
  for (const sc of (state.similarCandidates || [])) {
    if (!dismissedIds.has(sc.id)) candidateMap.set(sc.id, sc);
  }
  for (const cid of confirmedIds) {
    if (!candidateMap.has(cid)) {
      const c = state.clusters.find((x) => x.id === cid);
      if (c) candidateMap.set(cid, c);
    }
  }

  const items = Array.from(candidateMap.values());
  if (!items.length) {
    box.hidden = true;
    listEl.innerHTML = '';
    return;
  }

  listEl.innerHTML = '';
  const isAdmin = Boolean(getAdminToken());
  items.forEach((sc) => {
    const isConf = confirmedIds.has(sc.id);
    const card = document.createElement('div');
    card.className = `similar-face-card${isConf ? ' confirmed' : ''}`;
    card.innerHTML = `
      <img src="${sc.avatarDataUrl || ''}" alt="${sc.label}" />
      <div class="similar-face-meta">
        <div style="font-weight:700;color:var(--text);">${sc.label}</div>
        <div style="color:var(--text-muted);">${sc.photoCount || 0} รูป${sc.similarity ? ` • คล้าย ${sc.similarity}%` : ''}</div>
      </div>
      <div class="similar-face-btns">
        <button type="button" class="btn-xs-confirm">${isConf ? '✓ รวมแล้ว (ยกเลิก)' : '✓ ใช่ คนเดียวกัน'}</button>
        ${!isConf ? '<button type="button" class="btn-xs-dismiss" title="ไม่ใช่คนเดียวกัน">✕</button>' : ''}
        ${isAdmin && state.activeClusterId ? '<button type="button" class="btn-xs-dismiss" data-admin-merge="1" title="รวมถาวรสำหรับทุกคน (Admin)">🔗 รวมถาวร</button>' : ''}
      </div>
    `;

    card.querySelector('.btn-xs-confirm').addEventListener('click', () => {
      const cur = loadUserFaceMerges();
      cur.confirmed = cur.confirmed || {};
      const arr = new Set(cur.confirmed[key] || []);
      if (arr.has(sc.id)) {
        arr.delete(sc.id);
        showAppToast(`ยกเลิกการรวม ${sc.label} แล้ว`);
      } else {
        arr.add(sc.id);
        showAppToast(`✓ รวมรูปของ ${sc.label} เข้ามาแสดงด้วยแล้ว`);
      }
      cur.confirmed[key] = Array.from(arr);
      saveUserFaceMerges(cur);
      renderSimilarFacesUI();
      syncFilterBannerUI();
      renderPhotoGrid();
    });

    const dismissBtn = card.querySelector('.btn-xs-dismiss:not([data-admin-merge])');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => {
        const cur = loadUserFaceMerges();
        cur.dismissed = cur.dismissed || {};
        const dArr = new Set(cur.dismissed[key] || []);
        dArr.add(sc.id);
        cur.dismissed[key] = Array.from(dArr);
        saveUserFaceMerges(cur);
        renderSimilarFacesUI();
      });
    }

    const adminMergeBtn = card.querySelector('[data-admin-merge="1"]');
    if (adminMergeBtn) {
      adminMergeBtn.addEventListener('click', async () => {
        const ok = await showAppConfirm(`รวม "${sc.label}" เข้ากับบุคคลปัจจุบันอย่างถาวรสำหรับผู้ใช้ทุกคนใช่หรือไม่?`, { icon: '🔗', title: 'ยืนยันรวมกลุ่มถาวร (Admin)' });
        if (!ok) return;
        const resp = await fetch('/api/clusters/merge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-token': getAdminToken() },
          body: JSON.stringify({ targetClusterId: state.activeClusterId, sourceClusterId: sc.id })
        }).then((r) => r.json());
        if (resp.ok) {
          showAppToast('รวมกลุ่มใบหน้าถาวรเรียบร้อยแล้ว');
          await fetchStatusAndPhotos();
          loadSimilarClustersForActive(state.activeClusterId);
        } else {
          showAppAlert(resp.error || 'รวมกลุ่มไม่สำเร็จ');
        }
      });
    }

    listEl.appendChild(card);
  });

  box.hidden = false;
}

function getVisiblePhotos() {
  const confirmedExtraClusterIds = getConfirmedSimilarClusterIds();
  let list = [];
  if (Array.isArray(state.searchMatches)) {
    list = [...state.searchMatches];
    if (confirmedExtraClusterIds.length > 0) {
      const seen = new Set(list.map((p) => p.id));
      for (const p of state.photos) {
        if (!seen.has(p.id) && Array.isArray(p.clusterIds) && confirmedExtraClusterIds.some((cid) => p.clusterIds.includes(cid))) {
          seen.add(p.id);
          list.push(p);
        }
      }
    }
  } else if (state.activeClusterId) {
    const validClusters = new Set([state.activeClusterId, ...confirmedExtraClusterIds]);
    list = state.photos.filter((p) => Array.isArray(p.clusterIds) && p.clusterIds.some((cid) => validClusters.has(cid)));
  } else {
    list = state.photos;
  }

  if (state.extraFriends.length > 0) {
    list = list.filter((p) => state.extraFriends.every((f) => f.photoIds && f.photoIds.has(p.id)));
  }
  return list;
}

function clearAllFilters() {
  state.activeClusterId = null;
  state.searchMatches = null;
  state.lastQuery = null;
  state.lastSearchMeta = null;
  state.extraFriends = [];
  state.similarCandidates = [];
  state.visiblePageLimit = 40;
  $('fileInputQueryFace').value = '';
  $('fileInputSelfieCapture').value = '';
  renderSimilarFacesUI();
  syncFilterBannerUI();
  renderClusters();
  renderPhotoGrid();
}

function renderAiGraphicTag(label, mode = 'done') {
  if (mode === 'working') {
    return `<span class="ai-status-pill is-working"><span class="ai-radar-spinner"></span><span>กำลังดำเนินการ • ${label}</span></span>`;
  }
  return `<span class="ai-status-pill is-done"><span class="ai-done-check">✓</span><span>ดำเนินการเสร็จแล้ว • ${label}</span></span>`;
}

function syncFilterBannerUI() {
  const hasSearch = Array.isArray(state.searchMatches);
  const hasCluster = Boolean(state.activeClusterId);
  const filtered = hasSearch || hasCluster;

  $('btnClearFaceFilter').hidden = !filtered;
  $('activeSearchBar').hidden = !filtered;

  const thumb = $('queryFacePreviewImg');
  const extraWrap = $('queryFriendAvatarsWrap');
  const title = $('activeFilterTitle');
  const tagWrap = $('activeEngineTagWrap');
  const sub = $('activeFilterSub');
  const addBtn = $('btnOpenAddFriendModal');

  if (!filtered) {
    thumb.hidden = true;
    thumb.removeAttribute('src');
    if (extraWrap) extraWrap.innerHTML = '';
    tagWrap.innerHTML = '';
    sub.textContent = '';
    return;
  }

  // Render 3-slot visual row: [Primary] + [Friend 1 or +] + [Friend 2 or +]
  if (extraWrap) {
    extraWrap.innerHTML = '';
    for (let slot = 0; slot < 2; slot++) {
      const friend = state.extraFriends[slot];
      const plus = document.createElement('span');
      plus.className = 'active-search-plus';
      plus.textContent = '+';
      extraWrap.appendChild(plus);

      if (friend) {
        const wrap = document.createElement('div');
        wrap.className = 'friend-slot-wrap';
        wrap.innerHTML = `
          <img class="active-search-thumb-friend" src="${friend.avatarUrl || ''}" alt="${friend.label}" title="${friend.label}" />
          <button class="friend-slot-remove" type="button" title="เอา ${friend.label} ออก" aria-label="เอาออก">✕</button>
        `;
        wrap.querySelector('button').addEventListener('click', () => {
          state.extraFriends.splice(slot, 1);
          syncFilterBannerUI();
          renderPhotoGrid();
        });
        extraWrap.appendChild(wrap);
      } else {
        const addSlot = document.createElement('button');
        addSlot.type = 'button';
        addSlot.className = 'friend-slot-add';
        addSlot.innerHTML = '<span style="font-size:1.25rem;line-height:1;">＋</span><span>เพิ่มเพื่อน</span>';
        addSlot.addEventListener('click', openAddFriendModal);
        extraWrap.appendChild(addSlot);
      }
    }
  }
  if (addBtn) addBtn.hidden = state.extraFriends.length >= 2;

  const visibleCount = getVisiblePhotos().length;
  const hasFriends = state.extraFriends.length > 0;
  const totalPeople = 1 + state.extraFriends.length;

  if (hasSearch) {
    const avatar = state.lastSearchMeta && state.lastSearchMeta.queryFaceAvatarUrl
      ? state.lastSearchMeta.queryFaceAvatarUrl
      : (state.lastQuery && state.lastQuery.avatarUrl) || '';
    if (avatar) { thumb.src = avatar; thumb.hidden = false; } else { thumb.hidden = true; }

    title.textContent = hasFriends
      ? `พบ ${visibleCount} รูปที่อยู่ด้วยกัน (${totalPeople} คน)`
      : `พบ ${visibleCount} รูปที่ตรงกัน`;
    tagWrap.innerHTML = renderAiGraphicTag(hasFriends ? `👥 ค้นหารูปคู่/กลุ่ม (${totalPeople} คน)` : '✨ ค้นหาภาพด้วย AI สำเร็จ');

    const notes = [];
    const meta = state.lastSearchMeta || {};
    if (meta.expandedCount > 0 && !hasFriends) notes.push(`ค้นต่อยอดเพิ่ม ${meta.expandedCount} รูป`);
    if (meta.geminiError) notes.push(meta.geminiError);
    sub.textContent = notes.join(' • ');
  } else {
    const c = state.clusters.find((x) => x.id === state.activeClusterId);
    if (c && c.avatarDataUrl) { thumb.src = c.avatarDataUrl; thumb.hidden = false; } else { thumb.hidden = true; }
    title.textContent = hasFriends
      ? `ภาพที่อยู่ด้วยกัน ${totalPeople} คน (${visibleCount} รูป)`
      : `${c ? c.label : 'บุคคลที่เลือก'} (${visibleCount} รูป)`;
    tagWrap.innerHTML = renderAiGraphicTag(hasFriends ? `👥 ${[c ? c.label : '', ...state.extraFriends.map((f) => f.label)].filter(Boolean).join(' + ')}` : '👤 คัดแยกบุคคลอัตโนมัติ');
    sub.textContent = '';
  }
}

function updateSelectedCountUI() {
  const n = state.selectedPhotoIds.size;
  $('selectedCountSpan').textContent = n;
  $('btnDownloadZip').disabled = n === 0;
  if ($('shareSelectedCountSpan')) $('shareSelectedCountSpan').textContent = n;
  if ($('btnShareLineSelected')) $('btnShareLineSelected').disabled = n === 0;
}

function renderPhotoGrid() {
  const visible = getVisiblePhotos();
  $('visibleCountSpan').textContent = visible.length;
  $('statTotalPhotos').textContent = state.photos.length;

  const grid = $('photoGrid');
  const empty = $('emptyState');
  const loadMoreWrap = $('loadMoreWrap');
  const loadMoreBtn = $('btnLoadMorePhotos');
  grid.innerHTML = '';

  if (!visible.length) {
    empty.hidden = false;
    if (loadMoreWrap) loadMoreWrap.hidden = true;
    empty.textContent = (state.searchMatches || state.activeClusterId)
      ? 'ไม่พบรูปที่ตรงกับการค้นหา (ลองเลื่อนความเข้มงวดลง หรือใช้รูปที่เห็นหน้าชัดขึ้น)'
      : 'ยังไม่มีรูปภาพในอัลบั้ม';
    updateSelectedCountUI();
    return;
  }
  empty.hidden = true;

  const limit = state.visiblePageLimit || 40;
  const sliced = visible.slice(0, limit);
  const remaining = visible.length - sliced.length;
  if (loadMoreWrap && loadMoreBtn) {
    if (remaining > 0) {
      loadMoreBtn.textContent = `⬇️ ดูรูปเพิ่มเติม (อีก ${remaining} รูป)`;
      loadMoreWrap.hidden = false;
    } else {
      loadMoreWrap.hidden = true;
    }
  }

  for (const photo of sliced) {
    const isSelected = state.selectedPhotoIds.has(photo.id);
    const card = document.createElement('div');
    card.className = `photo-card${isSelected ? ' selected' : ''}`;

    let badge = '';
    if (photo.matchSimilarity) {
      const cls = photo.aiVerified ? 'match-badge ai-verified' : 'match-badge svm-verified';
      const label = photo.aiVerified ? `✨ ${photo.matchSimilarity}%` : `🎯 ${photo.matchSimilarity}%`;
      badge = `<span class="${cls}">${label}${photo.expandedMatched ? ' +' : ''}</span>`;
    }

    card.innerHTML = `
      <input type="checkbox" class="photo-select-check" ${isSelected ? 'checked' : ''} aria-label="เลือกรูป" />
      ${badge}
      <img class="photo-thumb" src="${photo.thumbUrl}" alt="${photo.name}" loading="lazy" />
      <a class="photo-quick-dl" href="${photo.downloadUrl}" download="${photo.name}" title="ดาวน์โหลด">⬇</a>
    `;

    const checkbox = card.querySelector('.photo-select-check');
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
      if (checkbox.checked) { state.selectedPhotoIds.add(photo.id); card.classList.add('selected'); }
      else { state.selectedPhotoIds.delete(photo.id); card.classList.remove('selected'); }
      updateSelectedCountUI();
    });
    card.querySelector('.photo-quick-dl').addEventListener('click', (e) => e.stopPropagation());
    card.addEventListener('click', () => openLightbox(photo));
    grid.appendChild(card);
  }
  updateSelectedCountUI();
}

// ============================================================================
// Upload (server does face detection + ArcFace embedding)
// ============================================================================

async function handleUploadFiles(fileList, sourceLabel = 'web_upload') {
  const files = Array.from(fileList || []).filter((f) =>
    f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif)$/i.test(f.name)
  );
  if (!files.length) { showAppAlert('ไม่พบไฟล์รูปภาพที่รองรับ'); return; }

  const box = $('uploadProgressBox');
  const text = $('uploadProgressText');
  const bar = $('uploadProgressBar');
  box.hidden = false;
  bar.style.width = '3%';
  text.innerHTML = renderAiGraphicTag(`กำลังอัปโหลดและสแกนใบหน้า (0/${files.length} รูป)...`, 'working');

  let completed = 0;
  let failed = 0;
  let cursor = 0;
  const CONCURRENCY = Math.min(3, files.length);

  const worker = async () => {
    while (cursor < files.length) {
      const idx = cursor++;
      const file = files[idx];
      text.textContent = `กำลังอัปโหลดและสแกนใบหน้า (${completed + 1}/${files.length}): ${file.name}`;
      try {
        const qs = new URLSearchParams({
          name: file.name,
          mimeType: file.type || 'image/jpeg',
          source: sourceLabel,
          deferCluster: files.length > 1 ? '1' : '0'
        });
        const resp = await fetch(`/api/photos/upload-binary?${qs.toString()}`, {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file
        }).then((r) => r.json());
        if (!resp.ok) failed++;
      } catch (err) {
        failed++;
        console.error(`Upload failed for ${file.name}:`, err);
      } finally {
        completed++;
        bar.style.width = `${Math.round((completed / files.length) * 100)}%`;
        text.textContent = `อัปโหลดแล้ว ${completed}/${files.length} รูป...`;
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  if (files.length > 1) {
    text.textContent = 'กำลังจัดกลุ่มใบหน้า...';
    await fetch('/api/photos/recluster', { method: 'POST' }).catch(() => {});
  }

  bar.style.width = '100%';
  const doneLabel = failed
    ? `สำเร็จ ${files.length - failed} รูป (ล้มเหลว ${failed}) • ซิงก์ Google Drive เบื้องหลัง`
    : `อัปโหลดและสแกนใบหน้าครบ ${files.length} รูป • ซิงก์ Google Drive เบื้องหลัง`;
  text.innerHTML = renderAiGraphicTag(doneLabel, 'done');
  showAppToast(`✓ อัปโหลดสำเร็จ ${files.length - failed} รูป`);
  await fetchStatusAndPhotos();
  setTimeout(() => { box.hidden = true; }, 3200);
}

// ============================================================================
// Search
// ============================================================================

function currentEngineMode() {
  return (state.searchEngineMode === 'arcface_gemini' && state.hasGeminiKey) ? 'arcface_gemini' : 'arcface';
}

async function executeSearch(query) {
  const mode = currentEngineMode();
  $('activeSearchBar').hidden = false;
  $('btnClearFaceFilter').hidden = false;
  if (query.avatarUrl) { $('queryFacePreviewImg').src = query.avatarUrl; $('queryFacePreviewImg').hidden = false; }

  $('activeFilterTitle').textContent = 'กำลังดำเนินการวิเคราะห์ใบหน้า...';
  $('activeEngineTagWrap').innerHTML = renderAiGraphicTag('กำลังสแกนและคัดแยกใบหน้าด้วย AI', 'working');
  $('activeFilterSub').textContent = '';
  state.similarCandidates = [];
  renderSimilarFacesUI();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);

  try {
    const payload = {
      engineMode: mode,
      threshold: Number($('thresholdSlider').value) || 0.38
    };
    if (query.type === 'face') {
      payload.sourcePhotoId = query.sourcePhotoId;
      payload.sourceFaceIndex = query.sourceFaceIndex;
    } else {
      payload.queryImageBase64 = query.queryImageBase64;
    }

    const resp = await fetch('/api/faces/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal
    }).then((r) => r.json());

    if (!resp.ok) {
      $('activeFilterTitle').textContent = resp.error || 'ค้นหาไม่สำเร็จ';
      $('activeEngineTagWrap').innerHTML = '';
      return;
    }

    if (resp.noFaceInQuery) {
      state.activeClusterId = null;
      state.searchMatches = [];
      state.lastSearchMeta = { durationMs: resp.durationMs };
      syncFilterBannerUI();
      $('activeFilterTitle').textContent = 'ไม่พบใบหน้าในภาพที่ใช้ค้นหา';
      $('activeFilterSub').textContent = 'กรุณาถ่ายให้เห็นใบหน้าชัดเจนและมีแสงเพียงพอ';
      renderClusters();
      renderPhotoGrid();
      return;
    }

    state.activeClusterId = null;
    state.searchMatches = resp.results || [];
    state.similarCandidates = Array.isArray(resp.similarClusters) ? resp.similarClusters : [];
    state.visiblePageLimit = 40;
    state.lastSearchMeta = {
      geminiUsed: Boolean(resp.geminiUsed),
      geminiModel: resp.geminiModel || '',
      geminiError: resp.geminiError || '',
      expandedCount: resp.expandedCount || 0,
      queryFaceAvatarUrl: resp.queryFaceAvatarUrl || query.avatarUrl || '',
      durationMs: resp.durationMs || 0
    };
    syncFilterBannerUI();
    renderSimilarFacesUI();
    renderClusters();
    renderPhotoGrid();
    switchTab('search');

    const savedAvatar = resp.queryFaceAvatarUrl || query.avatarUrl || '';
    if (savedAvatar || query.queryImageBase64) {
      saveGuestAvatar({
        type: query.type || 'image',
        avatarUrl: savedAvatar,
        queryImageBase64: query.queryImageBase64 || savedAvatar,
        sourcePhotoId: query.sourcePhotoId || '',
        sourceFaceIndex: query.sourceFaceIndex
      });
    }
  } catch (err) {
    $('activeFilterTitle').textContent = err.name === 'AbortError'
      ? 'หมดเวลาค้นหา (กรุณาลองใหม่)'
      : `ข้อผิดพลาด: ${err.message}`;
    $('activeEngineTagWrap').innerHTML = '';
  } finally {
    clearTimeout(timer);
  }
}

async function searchFromImageElement(imgOrCanvas) {
  const queryImageBase64 = downscaleToDataUrl(imgOrCanvas, 1024, 0.9);
  state.lastQuery = {
    type: 'image',
    queryImageBase64,
    avatarUrl: downscaleToDataUrl(imgOrCanvas, 160, 0.8)
  };
  await executeSearch(state.lastQuery);
}

async function openSelfieCamera(target = 'primary') {
  state.selfieCaptureTarget = target === 'friend' ? 'friend' : 'primary';
  const native = state.selfieCaptureTarget === 'friend' ? $('fileInputFriendSelfie') : $('fileInputSelfieCapture');
  const isInApp = /Line\/|FBAN|FBAV|Instagram/i.test(navigator.userAgent || '');
  const canWebRtc = Boolean(!isInApp && window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  if (!canWebRtc) { if (native) native.click(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 960 } },
      audio: false
    });
    state.selfieStream = stream;
    $('selfieVideo').srcObject = stream;
    $('selfieModal').hidden = false;
  } catch {
    native.click();
  }
}

function closeSelfieCamera() {
  $('selfieModal').hidden = true;
  if (state.selfieStream) {
    state.selfieStream.getTracks().forEach((t) => t.stop());
    state.selfieStream = null;
  }
}

// ============================================================================
// Lightbox with Tap-a-Face
// ============================================================================

function stepLightbox(delta) {
  const visible = getVisiblePhotos();
  if (!visible.length || !state.currentLightboxPhoto) return;
  const idx = visible.findIndex((p) => p.id === state.currentLightboxPhoto.id);
  const nextIdx = idx + delta;
  if (nextIdx >= 0 && nextIdx < visible.length) {
    openLightbox(visible[nextIdx]);
  }
}

function openLightbox(photo) {
  state.currentLightboxPhoto = photo;
  const visible = getVisiblePhotos();
  const idx = visible.findIndex((p) => p.id === photo.id);
  const posLabel = idx >= 0 ? ` (${idx + 1}/${visible.length})` : '';
  $('lightboxTitle').textContent = `${photo.name}${posLabel}`;

  const prevBtn = $('btnLightboxPrev');
  const nextBtn = $('btnLightboxNext');
  if (prevBtn) prevBtn.disabled = idx <= 0;
  if (nextBtn) nextBtn.disabled = idx < 0 || idx >= visible.length - 1;
  if ($('btnDeletePhotoAdmin')) $('btnDeletePhotoAdmin').hidden = !getAdminToken();
  const img = $('lightboxImg');
  const layer = $('lightboxFaceLayer');
  layer.innerHTML = '';
  $('lightboxFaceHint').hidden = true;

  const dl = $('lightboxDownloadLink');
  dl.href = photo.downloadUrl;
  dl.setAttribute('download', photo.name);

  const meta = [];
  if (photo.matchSimilarity) meta.push(photo.aiVerified ? `✨ ตรงกัน ${photo.matchSimilarity}%` : `🎯 ตรงกัน ${photo.matchSimilarity}%`);
  if (photo.faceCount) meta.push(`${photo.faceCount} ใบหน้า`);
  $('lightboxMetaText').textContent = meta.join(' • ');

  const driveLink = $('lightboxDriveLink');
  if (photo.webViewLink) { driveLink.href = photo.webViewLink; driveLink.hidden = false; } else { driveLink.hidden = true; }

  const drawFaces = () => {
    layer.innerHTML = '';
    layer.hidden = !state.showFaceBoxes;
    const toggleBtn = $('btnToggleFaceBoxes');
    if (toggleBtn) toggleBtn.textContent = state.showFaceBoxes ? '👁️ ซ่อนกรอบหน้า' : '👁️ แสดงกรอบหน้า';
    const nw = photo.width || img.naturalWidth;
    const nh = photo.height || img.naturalHeight;
    if (!nw || !nh || !Array.isArray(photo.faces)) return;
    let any = false;
    photo.faces.forEach((f) => {
      if (!f.box) return;
      any = true;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'face-box';
      el.title = 'ค้นหารูปของคนนี้';
      el.style.left = `${(f.box.x / nw) * 100}%`;
      el.style.top = `${(f.box.y / nh) * 100}%`;
      el.style.width = `${(f.box.width / nw) * 100}%`;
      el.style.height = `${(f.box.height / nh) * 100}%`;
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        $('lightboxModal').hidden = true;
        state.lastQuery = { type: 'face', sourcePhotoId: photo.id, sourceFaceIndex: f.index, avatarUrl: f.avatarDataUrl || '' };
        switchTab('search');
        await executeSearch(state.lastQuery);
      });
      layer.appendChild(el);
    });
    $('lightboxFaceHint').hidden = !any;
  };

  img.onload = drawFaces;
  img.src = photo.previewUrl || photo.fileUrl;
  if (img.complete) drawFaces();
  $('lightboxModal').hidden = false;

  if (photo.faceCount > 0 && !Array.isArray(photo.faces)) {
    fetch(`/api/photos/${encodeURIComponent(photo.id)}/faces`)
      .then((r) => r.json())
      .then((data) => {
        if (data && data.ok && Array.isArray(data.faces)) {
          photo.faces = data.faces;
          if (data.width) photo.width = data.width;
          if (data.height) photo.height = data.height;
          if (state.currentLightboxPhoto && state.currentLightboxPhoto.id === photo.id && img.complete) {
            drawFaces();
          }
        }
      })
      .catch(() => {});
  }
}

// ============================================================================
// QR + ZIP
// ============================================================================

function withExternalBrowserParam(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!u.searchParams.has('openExternalBrowser')) {
      u.searchParams.set('openExternalBrowser', '1');
    }
    return u.toString();
  } catch {
    return rawUrl;
  }
}

function initInAppBrowserBanner() {
  const banner = $('inAppBrowserBanner');
  if (!banner) return;
  const ua = navigator.userAgent || '';
  const isInApp = /Line\/|FBAN|FBAV|Instagram/i.test(ua);
  if (!isInApp) {
    banner.hidden = true;
    return;
  }

  const isAndroid = /Android/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const hint = $('inAppBrowserHint');
  if (hint) {
    hint.innerHTML = isIOS
      ? 'กรุณากดปุ่ม <b>⋯ (มุมขวาล่าง)</b> แล้วเลือก <b>เปิดใน Safari</b> หรือคัดลอกลิงก์ไปเปิดใน Safari'
      : 'กดปุ่มด้านล่างเพื่อเปิดใน Chrome หรือกด <b>⋮</b> แล้วเลือก <b>เปิดในเบราว์เซอร์เริ่มต้น</b>';
  }

  const btnOpen = $('btnOpenExternalBrowser');
  if (btnOpen) {
    btnOpen.hidden = false;
    btnOpen.addEventListener('click', () => {
      const targetUrl = withExternalBrowserParam(window.location.href);
      if (isAndroid) {
        const clean = targetUrl.replace(/^https?:\/\//i, '');
        window.location.href = `intent://${clean}#Intent;scheme=https;package=com.android.chrome;end`;
      } else {
        window.open(targetUrl, '_blank', 'noopener') || (window.location.href = targetUrl);
      }
    });
  }

  const btnCopy = $('btnCopyCurrentUrl');
  if (btnCopy) {
    btnCopy.addEventListener('click', async () => {
      const urlToCopy = window.location.href.split('?')[0];
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(urlToCopy);
      } else {
        const tmp = document.createElement('input');
        tmp.value = urlToCopy;
        document.body.appendChild(tmp);
        tmp.select();
        document.execCommand('copy');
        document.body.removeChild(tmp);
      }
      showAppAlert('คัดลอกลิงก์แล้ว! นำไปวางเปิดใน Safari หรือ Chrome ได้เลยครับ', { icon: '📋', title: 'คัดลอกลิงก์สำเร็จ' });
    });
  }

  banner.hidden = false;
}

const ADMIN_TOKEN_KEY = 'rm6_admin_token_v1';
const VIEW_MODE_KEY = 'rm6_view_mode_v1';

function getAdminToken() {
  try { return window.sessionStorage.getItem(ADMIN_TOKEN_KEY) || ''; } catch { return ''; }
}

function setAdminToken(token) {
  try {
    if (token) window.sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
    else window.sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {}
}

function applyViewMode(mode) {
  const m = mode === 'mobile' || mode === 'desktop' ? mode : 'auto';
  document.body.classList.toggle('force-mobile', m === 'mobile');
  document.body.classList.toggle('force-desktop', m === 'desktop');
  try { window.localStorage.setItem(VIEW_MODE_KEY, m); } catch {}
  const btn = $('btnToggleViewMode');
  if (btn) {
    btn.textContent = m === 'mobile' ? '📱 มือถือ' : (m === 'desktop' ? '💻 คอม' : '🖥️ อัตโนมัติ');
  }
}

async function sharePhotosViaLine(photos) {
  const list = (photos || []).filter(Boolean);
  if (!list.length) return;
  try {
    if (navigator.share && navigator.canShare) {
      const files = [];
      for (const p of list.slice(0, 5)) {
        const url = p.downloadUrl || p.thumbUrl;
        if (!url) continue;
        const resp = await fetch(url);
        const blob = await resp.blob();
        files.push(new File([blob], p.name || 'photo.jpg', { type: blob.type || 'image/jpeg' }));
      }
      if (files.length && navigator.canShare({ files })) {
        await navigator.share({
          files,
          title: state.albumTitle,
          text: `รูปภาพจาก ${state.albumTitle}`
        });
        return;
      }
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return;
  }

  const first = list[0];
  const shareUrl = first.webViewLink || `${window.location.origin}${first.downloadUrl || ''}`;
  const lineUrl = `https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(shareUrl)}`;
  window.open(lineUrl, '_blank', 'noopener,noreferrer');
}

const GUEST_AVATAR_KEY = 'rm6_guest_avatar_v1';

function loadGuestAvatar() {
  try {
    const raw = window.localStorage.getItem(GUEST_AVATAR_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveGuestAvatar(entry) {
  try {
    if (!entry || (!entry.avatarUrl && !entry.queryImageBase64)) return;
    window.localStorage.setItem(GUEST_AVATAR_KEY, JSON.stringify({ ...entry, savedAt: Date.now() }));
    renderGuestAvatarBar();
  } catch {
    // Ignore storage quota errors
  }
}

function clearGuestAvatar() {
  try { window.localStorage.removeItem(GUEST_AVATAR_KEY); } catch {}
  renderGuestAvatarBar();
}

function renderGuestAvatarBar() {
  const bar = $('guestAvatarBar');
  if (!bar) return;
  const saved = loadGuestAvatar();
  if (!saved || (!saved.avatarUrl && !saved.queryImageBase64)) {
    bar.hidden = true;
    return;
  }
  const img = $('guestAvatarImg');
  if (img) {
    img.src = saved.avatarUrl || saved.queryImageBase64;
    img.hidden = !img.src;
  }
  bar.hidden = false;
}

function renderQrModal() {
  const input = $('qrUrlInput');
  const url = input.value.trim() || withExternalBrowserParam(state.lanUrl || window.location.origin);
  input.value = url;
  if (window.RM6QR) {
    window.RM6QR.renderToCanvas($('qrCanvas'), url, { pixelSize: 220, darkColor: '#a60062', lightColor: '#ffffff' });
  }
  $('qrModal').hidden = false;
}

async function downloadSelectedAsZip() {
  let ids = Array.from(state.selectedPhotoIds);
  if (!ids.length) return;
  if (ids.length > 40) {
    await showAppAlert('ดาวน์โหลด ZIP ได้ครั้งละไม่เกิน 40 รูป ระบบจะดาวน์โหลด 40 รูปแรกให้ก่อนครับ', { icon: '📦', title: 'จำกัดขนาดไฟล์ ZIP' });
    ids = ids.slice(0, 40);
  }
  const btn = $('btnDownloadZip');
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'กำลังเตรียม ZIP...';
  try {
    const resp = await fetch('/api/photos/download-zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    });
    if (!resp.ok) throw new Error('สร้างไฟล์ ZIP ไม่สำเร็จ');
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'RM6-Pink-Album-Photos.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    showAppAlert(err.message);
  } finally {
    btn.innerHTML = orig;
    updateSelectedCountUI();
  }
}

// ============================================================================
// Init
// ============================================================================

async function selectEngineMode(mode) {
  if (mode === 'arcface_gemini' && !state.hasGeminiKey) {
    $('btnOpenConfig').click();
    $('inputGeminiApiKey').focus();
    return;
  }
  state.searchEngineMode = mode;
  renderEngineModeUI();
  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ searchEngineMode: mode })
  });
  if (state.lastQuery) await executeSearch(state.lastQuery);
}

window.addEventListener('DOMContentLoaded', async () => {
  await fetchStatusAndPhotos();

  $('tabBtnSearch').addEventListener('click', () => switchTab('search'));
  $('tabBtnUpload').addEventListener('click', () => switchTab('upload'));

  // Upload
  const fileMulti = $('fileInputMultiple');
  const fileFolder = $('fileInputFolder');
  $('btnMobileUpload').addEventListener('click', () => fileMulti.click());
  $('btnFolderUpload').addEventListener('click', () => fileFolder.click());
  fileMulti.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length) handleUploadFiles(e.target.files, 'mobile_or_file_upload');
    e.target.value = '';
  });
  fileFolder.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length) handleUploadFiles(e.target.files, 'card_reader_folder');
    e.target.value = '';
  });
  const dz = $('uploadDropzone');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('dragover');
    if (e.dataTransfer && e.dataTransfer.files.length) handleUploadFiles(e.dataTransfer.files, 'card_reader_drag_drop');
  });

  // Drive sync
  $('btnSyncDrive').addEventListener('click', async () => {
    const btn = $('btnSyncDrive');
    btn.disabled = true;
    btn.textContent = 'กำลังซิงก์...';
    try {
      const resp = await fetch('/api/drive/sync', { method: 'POST' }).then((r) => r.json());
      if (!resp.ok) {
        await showAppAlert(resp.error || 'ซิงก์ไม่สำเร็จ');
        $('configModal').hidden = false;
      } else {
        await fetchStatusAndPhotos();
        await showAppAlert(`ดึงรูปใหม่ ${resp.pulledFromDrive || 0} รูป • ส่งขึ้น Drive ${resp.pushedToDrive || 0} รูป`, { icon: '☁️', title: 'ซิงก์ Google Drive สำเร็จ' });
      }
    } finally {
      btn.disabled = false;
      btn.textContent = '🔄 ซิงก์ Google Drive';
    }
  });

  // Re-scan whole folder with ArcFace
  const rescan = async () => {
    const btn = $('btnAnalyzeHogFolder');
    const box = $('uploadProgressBox');
    const text = $('uploadProgressText');
    const bar = $('uploadProgressBar');
    btn.disabled = true;
    btn.textContent = '🔄 กำลังดำเนินการสแกน...';
    if (box && text && bar) {
      box.hidden = false;
      bar.style.width = '45%';
      text.innerHTML = renderAiGraphicTag('กำลังคัดแยกและวิเคราะห์ใบหน้าทั้งโฟลเดอร์...', 'working');
    }
    try {
      const resp = await fetch('/api/photos/reindex-arcface', { method: 'POST' }).then((r) => r.json());
      if (resp.ok) {
        if (bar && text) {
          bar.style.width = '100%';
          text.innerHTML = renderAiGraphicTag(`สแกนครบ ${resp.indexedCount ?? 0} รูป (${resp.totalFaces ?? 0} ใบหน้า)`, 'done');
        }
        clearAllFilters();
        await fetchStatusAndPhotos();
        await showAppAlert(`วิเคราะห์ใบหน้าสำเร็จ ${resp.indexedCount ?? 0} รูป • พบทั้งหมด ${resp.totalFaces ?? 0} ใบหน้า`, { icon: '🎯', title: 'ดำเนินการเสร็จแล้ว' });
      } else {
        await showAppAlert(resp.error || 'สแกนไม่สำเร็จ');
      }
    } finally {
      btn.disabled = false;
      btn.textContent = '🎯 สแกนใบหน้าทั้งโฟลเดอร์ใหม่';
      if (box) setTimeout(() => { box.hidden = true; }, 2200);
    }
  };
  $('btnAnalyzeHogFolder').addEventListener('click', rescan);
  $('btnReindexUnindexed').addEventListener('click', rescan);
  $('btnResetAllFaces').addEventListener('click', async () => {
    $('configModal').hidden = true;
    await rescan();
  });

  // Settings 2-Tab Switcher (ตกแต่ง / Admin)
  const switchConfigTab = (tab) => {
    const isDecor = tab !== 'admin';
    if ($('cfgPanelDecor')) $('cfgPanelDecor').hidden = !isDecor;
    if ($('cfgPanelAdmin')) $('cfgPanelAdmin').hidden = isDecor;
    if ($('cfgTabBtnDecor')) $('cfgTabBtnDecor').classList.toggle('active', isDecor);
    if ($('cfgTabBtnAdmin')) $('cfgTabBtnAdmin').classList.toggle('active', !isDecor);
  };
  if ($('cfgTabBtnDecor')) $('cfgTabBtnDecor').addEventListener('click', () => switchConfigTab('decor'));
  if ($('cfgTabBtnAdmin')) $('cfgTabBtnAdmin').addEventListener('click', () => switchConfigTab('admin'));

  // Settings (Protected by Admin Login)
  const openConfigModalUI = () => {
    switchConfigTab('decor');
    state.pendingLogoDataUrl = undefined;
    state.pendingBankLogoDataUrl = undefined;
    state.pendingLandingBgImageUrl = undefined;
    $('inputAlbumTitle').value = state.albumTitle;
    $('inputDriveFolderUrl').value = state.driveFolderUrl || state.driveFolderId;
    $('inputDefaultEngineMode').value = state.searchEngineMode || 'arcface_gemini';
    $('inputOauthClientId').value = state.oauthClientId || '';
    $('inputNewAdminPassword').value = '';
    $('inputLandingBgGradient').value = state.landingBgGradient || 'gsb_pink';
    if ($('inputLandingExpireDays')) $('inputLandingExpireDays').value = String(state.landingExpireDays ?? 5);
    $('inputLandingTitle1').value = state.landingTitle1 || '';
    $('inputLandingTitle2').value = state.landingTitle2 || '';
    $('inputLandingLocation1').value = state.landingLocation1 || '';
    $('inputLandingLocation2').value = state.landingLocation2 || '';
    $('inputLandingDate').value = state.landingDate || '';
    const bgPreview = $('landingBgPreview');
    if (bgPreview) {
      if (state.landingBgImageUrl) { bgPreview.src = state.landingBgImageUrl; bgPreview.hidden = false; }
      else { bgPreview.hidden = true; bgPreview.removeAttribute('src'); }
    }
    const bankPreview = $('bankLogoPreview');
    if (bankPreview) {
      if (state.bankLogoDataUrl) { bankPreview.src = state.bankLogoDataUrl; bankPreview.hidden = false; }
      else { bankPreview.hidden = true; bankPreview.removeAttribute('src'); }
    }
    const logoPreview = $('eventLogoPreview');
    if (logoPreview) {
      if (state.eventLogoDataUrl) { logoPreview.src = state.eventLogoDataUrl; logoPreview.hidden = false; }
      else { logoPreview.hidden = true; logoPreview.removeAttribute('src'); }
    }
    const sec = $('inputOauthClientSecret');
    sec.value = '';
    sec.placeholder = state.hasOauthOwner ? '•••••••••••• (เชื่อมต่อบัญชีแล้ว)' : 'GOCSPX-...';
    const gem = $('inputGeminiApiKey');
    gem.value = '';
    gem.placeholder = state.hasGeminiKey ? '•••••••••••• (บันทึกคีย์ไว้แล้ว)' : 'AIzaSy... หรือ AQ...';
    $('geminiTestResult').hidden = true;
    $('configModal').hidden = false;
  };

  $('btnOpenConfig').addEventListener('click', async () => {
    const token = getAdminToken();
    if (token) {
      const check = await fetch('/api/auth/verify', { headers: { 'x-admin-token': token } }).then((r) => r.json()).catch(() => ({}));
      if (check && check.authenticated) {
        openConfigModalUI();
        return;
      }
      setAdminToken('');
    }
    $('inputAdminPassword').value = '';
    $('adminLoginError').hidden = true;
    $('adminLoginModal').hidden = false;
    setTimeout(() => $('inputAdminPassword').focus(), 50);
  });

  $('adminLoginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pwd = $('inputAdminPassword').value;
    const errEl = $('adminLoginError');
    errEl.hidden = true;
    const resp = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd })
    }).then((r) => r.json());
    if (!resp.ok || !resp.token) {
      errEl.textContent = resp.error || 'รหัสผ่านไม่ถูกต้อง';
      errEl.hidden = false;
      return;
    }
    setAdminToken(resp.token);
    $('adminLoginModal').hidden = true;
    openConfigModalUI();
  });

  if ($('inputLandingBgFile')) {
    $('inputLandingBgFile').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const img = await loadImage(file);
        const dataUrl = downscaleToDataUrl(img, 1440, 0.86);
        state.pendingLandingBgImageUrl = dataUrl;
        $('landingBgPreview').src = dataUrl;
        $('landingBgPreview').hidden = false;
      } catch (err) {
        showAppAlert(err.message);
      }
    });
  }
  if ($('btnClearLandingBg')) {
    $('btnClearLandingBg').addEventListener('click', () => {
      state.pendingLandingBgImageUrl = '';
      $('inputLandingBgFile').value = '';
      $('landingBgPreview').hidden = true;
      $('landingBgPreview').removeAttribute('src');
    });
  }

  if ($('inputBankLogoFile')) {
    $('inputBankLogoFile').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const img = await loadImage(file);
        const dataUrl = downscaleToDataUrl(img, 256, 0.9);
        state.pendingBankLogoDataUrl = dataUrl;
        $('bankLogoPreview').src = dataUrl;
        $('bankLogoPreview').hidden = false;
      } catch (err) {
        showAppAlert(err.message);
      }
    });
  }
  if ($('btnClearBankLogo')) {
    $('btnClearBankLogo').addEventListener('click', () => {
      state.pendingBankLogoDataUrl = '';
      $('inputBankLogoFile').value = '';
      $('bankLogoPreview').hidden = true;
      $('bankLogoPreview').removeAttribute('src');
    });
  }

  if ($('inputEventLogoFile')) {
    $('inputEventLogoFile').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const img = await loadImage(file);
        const dataUrl = downscaleToDataUrl(img, 256, 0.9);
        state.pendingLogoDataUrl = dataUrl;
        $('eventLogoPreview').src = dataUrl;
        $('eventLogoPreview').hidden = false;
      } catch (err) {
        showAppAlert(err.message);
      }
    });
  }
  if ($('btnClearEventLogo')) {
    $('btnClearEventLogo').addEventListener('click', () => {
      state.pendingLogoDataUrl = '';
      $('inputEventLogoFile').value = '';
      $('eventLogoPreview').hidden = true;
      $('eventLogoPreview').removeAttribute('src');
    });
  }

  $('btnConnectGoogleOauth').addEventListener('click', async () => {
    const clientId = $('inputOauthClientId').value.trim();
    const clientSecret = $('inputOauthClientSecret').value.trim();
    if (!clientId) {
      await showAppAlert('กรุณากรอก Google OAuth Client ID และ Client Secret ก่อนกดล็อกอิน');
      return;
    }
    const body = { oauthClientId: clientId };
    if (clientSecret) body.oauthClientSecret = clientSecret;
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': getAdminToken() },
      body: JSON.stringify(body)
    });
    window.location.href = '/api/drive/oauth/start?origin=' + encodeURIComponent(window.location.origin);
  });

  $('btnTestGeminiKey').addEventListener('click', async () => {
    const btn = $('btnTestGeminiKey');
    const out = $('geminiTestResult');
    const typedKey = $('inputGeminiApiKey').value.trim();
    btn.disabled = true;
    btn.textContent = 'กำลังทดสอบ...';
    out.hidden = false;
    out.style.color = 'var(--text-muted)';
    out.textContent = 'กำลังเชื่อมต่อ Gemini AI...';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 40000);
    try {
      const resp = await fetch('/api/gemini/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ geminiApiKey: typedKey }),
        signal: ctrl.signal
      }).then((r) => r.json());
      if (resp.ok) {
        out.style.color = '#047857';
        out.textContent = `✅ เชื่อมต่อสำเร็จ: ${resp.modelUsed} (${(resp.durationMs / 1000).toFixed(1)} วิ)`;
        await fetchStatusAndPhotos();
      } else {
        out.style.color = '#be123c';
        out.textContent = `❌ เชื่อมต่อไม่สำเร็จ: ${resp.error}`;
      }
    } catch (err) {
      out.style.color = '#be123c';
      out.textContent = err.name === 'AbortError' ? '❌ หมดเวลาเชื่อมต่อ กรุณาลองอีกครั้ง' : `❌ ${err.message}`;
    } finally {
      clearTimeout(timer);
      btn.disabled = false;
      btn.textContent = 'ทดสอบคีย์';
    }
  });

  $('configForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const mode = $('inputDefaultEngineMode').value || 'arcface_gemini';
    const payload = {
      albumTitle: $('inputAlbumTitle').value.trim(),
      driveFolderUrl: $('inputDriveFolderUrl').value.trim(),
      searchEngineMode: mode,
      faceMatchThreshold: Number($('thresholdSlider').value) || 0.40,
      landingBgGradient: $('inputLandingBgGradient') ? $('inputLandingBgGradient').value : 'gsb_pink',
      landingTitle1: $('inputLandingTitle1') ? $('inputLandingTitle1').value.trim() : '',
      landingTitle2: $('inputLandingTitle2') ? $('inputLandingTitle2').value.trim() : '',
      landingLocation1: $('inputLandingLocation1') ? $('inputLandingLocation1').value.trim() : '',
      landingLocation2: $('inputLandingLocation2') ? $('inputLandingLocation2').value.trim() : '',
      landingDate: $('inputLandingDate') ? $('inputLandingDate').value.trim() : '',
      landingExpireDays: $('inputLandingExpireDays') ? Number($('inputLandingExpireDays').value) : 5
    };
    if (state.pendingLogoDataUrl !== undefined) {
      payload.eventLogoDataUrl = state.pendingLogoDataUrl;
    }
    if (state.pendingBankLogoDataUrl !== undefined) {
      payload.bankLogoDataUrl = state.pendingBankLogoDataUrl;
    }
    if (state.pendingLandingBgImageUrl !== undefined) {
      payload.landingBgImageUrl = state.pendingLandingBgImageUrl;
    }
    const newPwd = $('inputNewAdminPassword') ? $('inputNewAdminPassword').value.trim() : '';
    if (newPwd) payload.newAdminPassword = newPwd;
    const gem = $('inputGeminiApiKey').value.trim();
    if (gem) payload.geminiApiKey = gem;
    const oid = $('inputOauthClientId').value.trim();
    if (oid) payload.oauthClientId = oid;
    const osec = $('inputOauthClientSecret').value.trim();
    if (osec) payload.oauthClientSecret = osec;
    const sa = $('inputServiceAccountJson').value.trim();
    if (sa) payload.serviceAccountJson = sa;

    const resp = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': getAdminToken() },
      body: JSON.stringify(payload)
    }).then((r) => r.json());
    if (resp.ok) {
      $('configModal').hidden = true;
      showAppToast('✓ บันทึกการตั้งค่าเรียบร้อยแล้ว');
      await fetchStatusAndPhotos();
    } else {
      await showAppAlert(resp.error || 'บันทึกไม่สำเร็จ');
    }
  });

  // Mobile / Desktop View Mode Toggle
  const savedView = (() => { try { return window.localStorage.getItem(VIEW_MODE_KEY) || 'auto'; } catch { return 'auto'; } })();
  applyViewMode(savedView);
  if ($('btnToggleViewMode')) {
    $('btnToggleViewMode').addEventListener('click', () => {
      const cur = document.body.classList.contains('force-mobile') ? 'mobile'
        : (document.body.classList.contains('force-desktop') ? 'desktop' : 'auto');
      const next = cur === 'auto' ? 'mobile' : (cur === 'mobile' ? 'desktop' : 'auto');
      applyViewMode(next);
    });
  }

  // Add Friend Popup Modal + Lightbox Left/Right navigation
  if ($('btnFriendSelfie')) $('btnFriendSelfie').addEventListener('click', () => openSelfieCamera('friend'));
  if ($('btnFriendPickPhoto')) $('btnFriendPickPhoto').addEventListener('click', () => $('fileInputFriendPhoto').click());
  const onFriendFacePicked = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try { await addFriendFromImageElement(await loadImage(file)); }
    catch (err) { showAppAlert(err.message); }
  };
  if ($('fileInputFriendSelfie')) $('fileInputFriendSelfie').addEventListener('change', onFriendFacePicked);
  if ($('fileInputFriendPhoto')) $('fileInputFriendPhoto').addEventListener('change', onFriendFacePicked);
  if ($('btnRetakeFriendSelfie')) {
    $('btnRetakeFriendSelfie').addEventListener('click', () => {
      const idx = state.extraFriends.map((f) => String(f.key).startsWith('selfie_')).lastIndexOf(true);
      if (idx >= 0) {
        state.extraFriends.splice(idx, 1);
        renderFriendPickerModal();
        syncFilterBannerUI();
        renderPhotoGrid();
      }
      openSelfieCamera('friend');
    });
  }
  if ($('btnDeletePhotoAdmin')) {
    $('btnDeletePhotoAdmin').addEventListener('click', async () => {
      const photo = state.currentLightboxPhoto;
      if (!photo) return;
      const confirmed = await showAppConfirm(`ยืนยันการลบรูป "${photo.name}" ออกจากระบบใช่หรือไม่?`, { icon: '🗑️', title: 'ยืนยันการลบรูปภาพ', okText: 'ลบรูปภาพ' });
      if (!confirmed) return;
      const resp = await fetch(`/api/photos/${encodeURIComponent(photo.id)}`, {
        method: 'DELETE',
        headers: { 'x-admin-token': getAdminToken() }
      }).then((r) => r.json());
      if (!resp.ok) {
        if (String(resp.error || '').includes('ผู้ดูแล')) {
          setAdminToken('');
          $('btnDeletePhotoAdmin').hidden = true;
        }
        await showAppAlert(resp.error || 'ลบรูปไม่สำเร็จ');
        return;
      }
      $('lightboxModal').hidden = true;
      state.selectedPhotoIds.delete(photo.id);
      if (Array.isArray(state.searchMatches)) {
        state.searchMatches = state.searchMatches.filter((m) => m.id !== photo.id);
      }
      showAppToast('🗑️ ลบรูปภาพเรียบร้อยแล้ว');
      await fetchStatusAndPhotos();
      syncFilterBannerUI();
    });
  }
  if ($('btnLightboxPrev')) $('btnLightboxPrev').addEventListener('click', () => stepLightbox(-1));
  if ($('btnLightboxNext')) $('btnLightboxNext').addEventListener('click', () => stepLightbox(1));
  document.addEventListener('keydown', (e) => {
    if ($('lightboxModal') && !$('lightboxModal').hidden) {
      if (e.key === 'ArrowLeft') stepLightbox(-1);
      else if (e.key === 'ArrowRight') stepLightbox(1);
    }
  });
  if ($('lightboxStage')) {
    let touchStartX = 0;
    $('lightboxStage').addEventListener('touchstart', (e) => {
      if (e.touches && e.touches[0]) touchStartX = e.touches[0].clientX;
    }, { passive: true });
    $('lightboxStage').addEventListener('touchend', (e) => {
      if (!e.changedTouches || !e.changedTouches[0]) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      if (Math.abs(dx) > 45) stepLightbox(dx < 0 ? 1 : -1);
    }, { passive: true });
  }
  if ($('btnToggleFaceBoxes')) {
    $('btnToggleFaceBoxes').addEventListener('click', () => {
      state.showFaceBoxes = !state.showFaceBoxes;
      const layer = $('lightboxFaceLayer');
      if (layer) layer.hidden = !state.showFaceBoxes;
      $('btnToggleFaceBoxes').textContent = state.showFaceBoxes ? '👁️ ซ่อนกรอบหน้า' : '👁️ แสดงกรอบหน้า';
    });
  }
  if ($('btnLandingSearch')) $('btnLandingSearch').addEventListener('click', () => switchTab('search'));
  if ($('btnLandingUpload')) $('btnLandingUpload').addEventListener('click', () => switchTab('upload'));
  if ($('brandHomeBtn')) $('brandHomeBtn').addEventListener('click', () => switchTab('landing'));
  switchTab('landing');
  if ($('btnShareLineLightbox')) {
    $('btnShareLineLightbox').addEventListener('click', () => {
      if (state.currentLightboxPhoto) sharePhotosViaLine([state.currentLightboxPhoto]);
    });
  }
  if ($('btnShareLineSelected')) {
    $('btnShareLineSelected').addEventListener('click', () => {
      const selected = state.photos.filter((p) => state.selectedPhotoIds.has(p.id));
      sharePhotosViaLine(selected);
    });
  }

  // QR
  $('btnOpenQr').addEventListener('click', () => { $('qrUrlInput').value = withExternalBrowserParam(state.lanUrl || window.location.origin); renderQrModal(); });

  // Guest Avatar & In-App Browser Banner
  initInAppBrowserBanner();
  renderGuestAvatarBar();
  if ($('btnSearchGuestAvatar')) {
    $('btnSearchGuestAvatar').addEventListener('click', async () => {
      const saved = loadGuestAvatar();
      if (!saved) return;
      if (saved.type === 'cluster' && saved.clusterId && state.clusters.some((c) => c.id === saved.clusterId)) {
        state.activeClusterId = saved.clusterId;
        state.searchMatches = null;
        syncFilterBannerUI();
        renderClusters();
        renderPhotoGrid();
        return;
      }
      await executeSearch({
        type: saved.type === 'face' && saved.sourcePhotoId ? 'face' : 'image',
        avatarUrl: saved.avatarUrl || saved.queryImageBase64,
        queryImageBase64: saved.queryImageBase64 || saved.avatarUrl,
        sourcePhotoId: saved.sourcePhotoId,
        sourceFaceIndex: saved.sourceFaceIndex
      });
    });
  }
  if ($('btnClearGuestAvatar')) {
    $('btnClearGuestAvatar').addEventListener('click', clearGuestAvatar);
  }
  $('qrUrlInput').addEventListener('input', renderQrModal);
  $('btnCopyQrLink').addEventListener('click', async () => {
    const val = $('qrUrlInput').value.trim();
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(val);
    else { $('qrUrlInput').select(); document.execCommand('copy'); }
    showAppToast('📋 คัดลอกลิงก์แล้ว');
  });
  $('btnDownloadQrPng').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = $('qrCanvas').toDataURL('image/png');
    a.download = 'RM6-Pink-Album-QR.png';
    a.click();
  });

  // Selfie / reference
  $('btnOpenSelfieCamera').addEventListener('click', () => openSelfieCamera('primary'));
  $('btnCloseSelfieModal').addEventListener('click', closeSelfieCamera);
  $('btnCaptureSelfie').addEventListener('click', async () => {
    const video = $('selfieVideo');
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 640;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    closeSelfieCamera();
    if (state.selfieCaptureTarget === 'friend') {
      await addFriendFromImageElement(canvas);
    } else {
      state.extraFriends = [];
      await searchFromImageElement(canvas);
    }
  });

  const onFacePicked = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      state.extraFriends = [];
      await searchFromImageElement(await loadImage(file));
    } catch (err) { showAppAlert(err.message); }
  };
  $('btnPickQueryFace').addEventListener('click', () => $('fileInputQueryFace').click());
  $('fileInputQueryFace').addEventListener('change', onFacePicked);
  $('fileInputSelfieCapture').addEventListener('change', onFacePicked);

  $('btnClearFaceFilter').addEventListener('click', (e) => { e.preventDefault(); clearAllFilters(); });
  $('btnClearSearchBanner').addEventListener('click', (e) => { e.preventDefault(); clearAllFilters(); });

  $('thresholdSlider').addEventListener('input', (e) => {
    $('thresholdValueLabel').textContent = Number(e.target.value).toFixed(2);
  });
  $('thresholdSlider').addEventListener('change', () => { if (state.lastQuery) executeSearch(state.lastQuery); });

  // Gallery selection / zip
  $('btnSelectAllVisible').addEventListener('click', () => {
    const visible = getVisiblePhotos();
    const all = visible.length > 0 && visible.every((p) => state.selectedPhotoIds.has(p.id));
    visible.forEach((p) => (all ? state.selectedPhotoIds.delete(p.id) : state.selectedPhotoIds.add(p.id)));
    renderPhotoGrid();
  });
  $('btnDownloadZip').addEventListener('click', downloadSelectedAsZip);
  if ($('btnLoadMorePhotos')) {
    $('btnLoadMorePhotos').addEventListener('click', () => {
      state.visiblePageLimit = (state.visiblePageLimit || 40) + 40;
      renderPhotoGrid();
    });
  }

  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => { const el = $(btn.getAttribute('data-close-modal')); if (el) el.hidden = true; });
  });
});
