'use strict';

/**
 * RM6 Pink Album — Client (Attendee-first, server-side InsightFace ArcFace 512-D)
 * - All face detection / embedding happens on the server (SCRFD + ArcFace), so phones just upload / search.
 * - Modes: "arcface" (default) and "arcface_gemini" (Gemini verifies borderline cases).
 * - Tap-a-Face in lightbox to search everything of that person.
 */

const state = {
  activeTab: 'search',
  albumTitle: 'RM6 Pink Album',
  driveFolderId: '',
  driveFolderUrl: '',
  driveAuthMode: 'local_only',
  oauthClientId: '',
  hasOauthOwner: false,
  hasGeminiKey: false,
  searchEngineMode: 'arcface', // 'arcface' | 'arcface_gemini'
  lanUrl: window.location.origin,
  photos: [],
  clusters: [],
  selectedPhotoIds: new Set(),
  showSinglePhotoClusters: false,
  activeClusterId: null,
  searchMatches: null,
  lastQuery: null, // { type: 'image'|'face', queryImageBase64?, sourcePhotoId?, sourceFaceIndex?, avatarUrl }
  lastSearchMeta: null,
  selfieStream: null
};

const $ = (id) => document.getElementById(id);

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
  state.activeTab = tab === 'upload' ? 'upload' : 'search';
  $('viewSearch').hidden = state.activeTab !== 'search';
  $('viewUpload').hidden = state.activeTab !== 'upload';
  $('tabBtnSearch').classList.toggle('active', state.activeTab === 'search');
  $('tabBtnUpload').classList.toggle('active', state.activeTab === 'upload');
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

function renderEngineModeUI() {
  let mode = state.searchEngineMode || 'arcface';
  if (mode === 'arcface_gemini' && !state.hasGeminiKey) mode = 'arcface';
  $('btnModeArcface').classList.toggle('active-hog', mode === 'arcface');
  $('btnModeGemini').classList.toggle('active-gemini', mode === 'arcface_gemini');
  $('geminiBadge').hidden = !state.hasGeminiKey;
}

async function fetchStatusAndPhotos() {
  const [statusResp, photosResp] = await Promise.all([
    fetch('/api/status').then((r) => r.json()),
    fetch('/api/photos').then((r) => r.json())
  ]);

  if (statusResp.ok) {
    state.albumTitle = statusResp.albumTitle || 'RM6 Pink Album';
    state.driveFolderId = statusResp.driveFolderId || '';
    state.driveFolderUrl = statusResp.driveFolderUrl || '';
    state.driveAuthMode = statusResp.driveAuthMode || 'local_only';
    state.oauthClientId = statusResp.oauthClientId || '';
    state.hasOauthOwner = Boolean(statusResp.hasOauthOwner);
    state.hasGeminiKey = Boolean(statusResp.hasGeminiKey);
    state.searchEngineMode = statusResp.searchEngineMode || 'arcface';
    const isLocalHost = /^(localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(window.location.hostname);
    state.lanUrl = isLocalHost ? (statusResp.lanUrl || window.location.origin) : window.location.origin;

    $('albumTitleHeading').textContent = state.albumTitle;
    document.title = state.albumTitle;
    renderEngineModeUI();

    $('aiEngineStatus').textContent = statusResp.arcFaceReady ? 'ArcFace พร้อมใช้งาน' : 'ไม่พบโมเดล ArcFace';

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
  $('statTotalPhotos').textContent = stats.totalPhotos || 0;
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
  const multi = state.clusters.filter((c) => c.photoCount >= 2);
  const display = (state.clusters.length <= 16 || state.showSinglePhotoClusters || multi.length === 0)
    ? state.clusters
    : multi;
  const hidden = state.clusters.length - display.length;
  $('statTotalClusters').textContent = display.length;

  for (const cluster of display) {
    const isActive = state.activeClusterId === cluster.id;
    const item = document.createElement('div');
    item.className = `cluster-item${isActive ? ' active' : ''}`;
    item.innerHTML = `
      <div class="cluster-avatar-wrap">
        <img class="cluster-avatar" src="${cluster.avatarDataUrl || ''}" alt="${cluster.label}" />
        <span class="cluster-count-badge">${cluster.photoCount}</span>
      </div>
      <div class="cluster-label" title="คลิกเพื่อกรอง / ดับเบิลคลิกเพื่อเปลี่ยนชื่อ">${cluster.label}</div>
    `;

    // Click a person => run a real ArcFace search with that person's face (finds back-row/side-angle shots too)
    item.addEventListener('click', () => {
      if (state.activeClusterId === cluster.id) { clearAllFilters(); return; }
      state.searchMatches = null;
      state.lastQuery = null;
      state.activeClusterId = cluster.id;
      saveGuestAvatar({ type: 'cluster', clusterId: cluster.id, avatarUrl: cluster.avatarDataUrl || '' });
      syncFilterBannerUI();
      renderClusters();
      renderPhotoGrid();
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

  if (hidden > 0 || (state.showSinglePhotoClusters && state.clusters.length > 16)) {
    const more = document.createElement('div');
    more.className = 'cluster-item';
    more.innerHTML = `
      <div class="cluster-avatar-wrap" style="display:flex;align-items:center;justify-content:center;background:var(--pink-50);color:var(--pink-600);font-weight:600;font-size:0.78rem;">
        ${state.showSinglePhotoClusters ? 'ย่อ' : `+${hidden}`}
      </div>
      <div class="cluster-label">${state.showSinglePhotoClusters ? 'ซ่อนรูปเดี่ยว' : 'ดูทั้งหมด'}</div>
    `;
    more.addEventListener('click', () => {
      state.showSinglePhotoClusters = !state.showSinglePhotoClusters;
      renderClusters();
    });
    strip.appendChild(more);
  }
}

function getVisiblePhotos() {
  if (Array.isArray(state.searchMatches)) return state.searchMatches;
  if (state.activeClusterId) {
    return state.photos.filter((p) => Array.isArray(p.clusterIds) && p.clusterIds.includes(state.activeClusterId));
  }
  return state.photos;
}

function clearAllFilters() {
  state.activeClusterId = null;
  state.searchMatches = null;
  state.lastQuery = null;
  state.lastSearchMeta = null;
  $('fileInputQueryFace').value = '';
  $('fileInputSelfieCapture').value = '';
  syncFilterBannerUI();
  renderClusters();
  renderPhotoGrid();
}

function syncFilterBannerUI() {
  const hasSearch = Array.isArray(state.searchMatches);
  const hasCluster = Boolean(state.activeClusterId);
  const filtered = hasSearch || hasCluster;

  $('btnClearFaceFilter').hidden = !filtered;
  $('activeSearchBar').hidden = !filtered;

  const thumb = $('queryFacePreviewImg');
  const title = $('activeFilterTitle');
  const tagWrap = $('activeEngineTagWrap');
  const sub = $('activeFilterSub');

  if (!filtered) {
    thumb.hidden = true;
    thumb.removeAttribute('src');
    tagWrap.innerHTML = '';
    sub.textContent = '';
    return;
  }

  if (hasSearch) {
    const avatar = state.lastSearchMeta && state.lastSearchMeta.queryFaceAvatarUrl
      ? state.lastSearchMeta.queryFaceAvatarUrl
      : (state.lastQuery && state.lastQuery.avatarUrl) || '';
    if (avatar) { thumb.src = avatar; thumb.hidden = false; } else { thumb.hidden = true; }

    title.textContent = `พบ ${state.searchMatches.length} รูปที่ตรงกัน`;
    const meta = state.lastSearchMeta || {};
    const secText = meta.durationMs !== undefined ? ` • ${(meta.durationMs / 1000).toFixed(1)} วิ` : '';

    if (meta.geminiUsed) {
      tagWrap.innerHTML = `<span class="engine-result-tag tag-gemini">✨ ArcFace + Gemini (${meta.geminiModel || 'AI'}${secText})</span>`;
    } else {
      tagWrap.innerHTML = `<span class="engine-result-tag tag-hog">🎯 ArcFace 512-D${secText}</span>`;
    }

    const notes = [];
    if (meta.expandedCount > 0) notes.push(`ค้นต่อยอดเพิ่ม ${meta.expandedCount} รูป`);
    if (meta.geminiError) notes.push(meta.geminiError);
    sub.textContent = notes.join(' • ');
  } else {
    const c = state.clusters.find((x) => x.id === state.activeClusterId);
    if (c && c.avatarDataUrl) { thumb.src = c.avatarDataUrl; thumb.hidden = false; } else { thumb.hidden = true; }
    title.textContent = `${c ? c.label : 'บุคคลที่เลือก'} (${getVisiblePhotos().length} รูป)`;
    tagWrap.innerHTML = `<span class="engine-result-tag tag-hog">🎯 จัดกลุ่มด้วย ArcFace 512-D</span>`;
    sub.textContent = '';
  }
}

function updateSelectedCountUI() {
  const n = state.selectedPhotoIds.size;
  $('selectedCountSpan').textContent = n;
  $('btnDownloadZip').disabled = n === 0;
}

function renderPhotoGrid() {
  const visible = getVisiblePhotos();
  $('visibleCountSpan').textContent = visible.length;
  $('statTotalPhotos').textContent = state.photos.length;

  const grid = $('photoGrid');
  const empty = $('emptyState');
  grid.innerHTML = '';

  if (!visible.length) {
    empty.hidden = false;
    empty.textContent = (state.searchMatches || state.activeClusterId)
      ? 'ไม่พบรูปที่ตรงกับการค้นหา (ลองเลื่อนความเข้มงวดลง หรือใช้รูปที่เห็นหน้าชัดขึ้น)'
      : 'ยังไม่มีรูปภาพในอัลบั้ม';
    updateSelectedCountUI();
    return;
  }
  empty.hidden = true;

  for (const photo of visible) {
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
  if (!files.length) { window.alert('ไม่พบไฟล์รูปภาพที่รองรับ'); return; }

  const box = $('uploadProgressBox');
  const text = $('uploadProgressText');
  const bar = $('uploadProgressBar');
  box.hidden = false;
  bar.style.width = '3%';
  let failed = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    bar.style.width = `${Math.round(((i + 0.3) / files.length) * 100)}%`;
    text.textContent = `กำลังอัปโหลดและสแกนใบหน้า (${i + 1}/${files.length}): ${file.name}`;
    try {
      const [dataBase64, img] = await Promise.all([fileToDataUrl(file), loadImage(file)]);
      const thumbBase64 = downscaleToDataUrl(img, 720, 0.84);
      const resp = await fetch('/api/photos/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: [{
            name: file.name,
            mimeType: file.type || 'image/jpeg',
            width: img.naturalWidth || img.width,
            height: img.naturalHeight || img.height,
            source: sourceLabel,
            dataBase64,
            thumbBase64
          }]
        })
      }).then((r) => r.json());
      if (!resp.ok) failed++;
    } catch (err) {
      failed++;
      console.error(`Upload failed for ${file.name}:`, err);
    }
  }

  bar.style.width = '100%';
  text.textContent = failed
    ? `เสร็จสิ้น (สำเร็จ ${files.length - failed} / ล้มเหลว ${failed})`
    : `อัปโหลดและสแกนใบหน้าสำเร็จ ${files.length} รูป`;
  await fetchStatusAndPhotos();
  setTimeout(() => { box.hidden = true; }, 2200);
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

  $('activeFilterTitle').textContent = 'กำลังค้นหา...';
  $('activeEngineTagWrap').innerHTML = mode === 'arcface_gemini'
    ? `<span class="engine-result-tag tag-gemini">🔄 ArcFace + Gemini กำลังทำงาน...</span>`
    : `<span class="engine-result-tag tag-hog">🔄 ArcFace 512-D กำลังทำงาน...</span>`;
  $('activeFilterSub').textContent = '';

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
    state.lastSearchMeta = {
      geminiUsed: Boolean(resp.geminiUsed),
      geminiModel: resp.geminiModel || '',
      geminiError: resp.geminiError || '',
      expandedCount: resp.expandedCount || 0,
      queryFaceAvatarUrl: resp.queryFaceAvatarUrl || query.avatarUrl || '',
      durationMs: resp.durationMs || 0
    };
    syncFilterBannerUI();
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

async function openSelfieCamera() {
  const native = $('fileInputSelfieCapture');
  const isInApp = /Line\/|FBAN|FBAV|Instagram/i.test(navigator.userAgent || '');
  const canWebRtc = Boolean(!isInApp && window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  if (!canWebRtc) { native.click(); return; }
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

function openLightbox(photo) {
  $('lightboxTitle').textContent = photo.name;
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
  img.src = photo.fileUrl;
  if (img.complete) drawFaces();
  $('lightboxModal').hidden = false;
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
    btnOpen.hidden = isIOS;
    btnOpen.addEventListener('click', () => {
      const targetUrl = withExternalBrowserParam(window.location.href);
      if (isAndroid) {
        const clean = targetUrl.replace(/^https?:\/\//i, '');
        window.location.href = `intent://${clean}#Intent;scheme=https;package=com.android.chrome;end`;
      } else {
        window.location.href = targetUrl;
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
      window.alert('คัดลอกลิงก์แล้ว! นำไปวางเปิดใน Safari หรือ Chrome ได้เลยครับ');
    });
  }

  banner.hidden = false;
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
  const ids = Array.from(state.selectedPhotoIds);
  if (!ids.length) return;
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
    window.alert(err.message);
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
        window.alert(resp.error || 'ซิงก์ไม่สำเร็จ');
        $('configModal').hidden = false;
      } else {
        await fetchStatusAndPhotos();
        window.alert(`ซิงก์สำเร็จ (ดึงใหม่ ${resp.pulledFromDrive || 0} รูป / ส่งขึ้น ${resp.pushedToDrive || 0} รูป)`);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = '🔄 ซิงก์ Google Drive';
    }
  });

  // Re-scan whole folder with ArcFace
  const rescan = async () => {
    const btn = $('btnAnalyzeHogFolder');
    btn.disabled = true;
    btn.textContent = 'กำลังสแกนใบหน้า...';
    try {
      const resp = await fetch('/api/photos/reindex-arcface', { method: 'POST' }).then((r) => r.json());
      if (resp.ok) {
        clearAllFilters();
        await fetchStatusAndPhotos();
        window.alert(`สแกนเสร็จแล้ว: ${resp.indexedCount ?? 0} รูป • ${resp.totalFaces ?? 0} ใบหน้า`);
      } else {
        window.alert(resp.error || 'สแกนไม่สำเร็จ');
      }
    } finally {
      btn.disabled = false;
      btn.textContent = '🎯 สแกนใบหน้าทั้งโฟลเดอร์ใหม่';
    }
  };
  $('btnAnalyzeHogFolder').addEventListener('click', rescan);
  $('btnReindexUnindexed').addEventListener('click', rescan);
  $('btnResetAllFaces').addEventListener('click', async () => {
    $('configModal').hidden = true;
    await rescan();
  });

  // Settings
  $('btnOpenConfig').addEventListener('click', () => {
    $('inputAlbumTitle').value = state.albumTitle;
    $('inputDriveFolderUrl').value = state.driveFolderUrl || state.driveFolderId;
    $('inputDefaultEngineMode').value = state.searchEngineMode || 'arcface';
    $('inputOauthClientId').value = state.oauthClientId || '';
    const sec = $('inputOauthClientSecret');
    sec.value = '';
    sec.placeholder = state.hasOauthOwner ? '•••••••••••• (เชื่อมต่อบัญชีแล้ว)' : 'GOCSPX-...';
    const gem = $('inputGeminiApiKey');
    gem.value = '';
    gem.placeholder = state.hasGeminiKey ? '•••••••••••• (บันทึกคีย์ไว้แล้ว)' : 'AIzaSy... หรือ AQ...';
    $('geminiTestResult').hidden = true;
    $('configModal').hidden = false;
  });

  $('btnConnectGoogleOauth').addEventListener('click', async () => {
    const clientId = $('inputOauthClientId').value.trim();
    const clientSecret = $('inputOauthClientSecret').value.trim();
    if (!clientId) {
      window.alert('กรุณากรอก Google OAuth Client ID และ Client Secret ก่อนกดล็อกอิน (Redirect URI: http://localhost:3000/api/drive/oauth/callback)');
      return;
    }
    const body = { oauthClientId: clientId };
    if (clientSecret) body.oauthClientSecret = clientSecret;
    await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
    const mode = $('inputDefaultEngineMode').value || 'arcface';
    const payload = {
      albumTitle: $('inputAlbumTitle').value.trim(),
      driveFolderUrl: $('inputDriveFolderUrl').value.trim(),
      searchEngineMode: mode
    };
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then((r) => r.json());
    if (resp.ok) { $('configModal').hidden = true; await fetchStatusAndPhotos(); }
    else window.alert(resp.error || 'บันทึกไม่สำเร็จ');
  });

  // Engine mode pills
  $('btnModeArcface').addEventListener('click', () => selectEngineMode('arcface'));
  $('btnModeGemini').addEventListener('click', () => selectEngineMode('arcface_gemini'));

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
    window.alert('คัดลอกลิงก์แล้ว');
  });
  $('btnDownloadQrPng').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = $('qrCanvas').toDataURL('image/png');
    a.download = 'RM6-Pink-Album-QR.png';
    a.click();
  });

  // Selfie / reference
  $('btnOpenSelfieCamera').addEventListener('click', openSelfieCamera);
  $('btnCloseSelfieModal').addEventListener('click', closeSelfieCamera);
  $('btnCaptureSelfie').addEventListener('click', async () => {
    const video = $('selfieVideo');
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 640;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    closeSelfieCamera();
    await searchFromImageElement(canvas);
  });

  const onFacePicked = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try { await searchFromImageElement(await loadImage(file)); }
    catch (err) { window.alert(err.message); }
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

  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => { const el = $(btn.getAttribute('data-close-modal')); if (el) el.hidden = true; });
  });
});
