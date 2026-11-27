'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAppServer } = require('../server');
const { searchByFaceVectors, recomputeClusters, cosineSimilarity } = require('../lib/face-engine');
const { ArcFaceService } = require('../lib/arcface-client');

const SAMPLE_JPEG_BASE64 =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

function unitVec(seed, noise = 0) {
  const v = new Array(512).fill(0);
  v[seed] = 1;
  v[(seed + 1) % 512] = noise;
  return v;
}

async function apiTests() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rm6-pink-test-'));
  const { server } = createAppServer({
    dataDir: path.join(tmpRoot, 'data'),
    storageDir: path.join(tmpRoot, 'storage'),
    disableArcFaceAutoStart: true
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body) => fetch(base + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }).then((r) => r.json());

  try {
    // 1. UI
    const html = await (await fetch(`${base}/`)).text();
    assert.ok(html.includes('Noto+Sans+Thai'));
    assert.ok(html.includes('capture="user"'));
    assert.ok(html.includes('ผู้พัฒนา นายพรชาย วงศ์กระจ่าง ธนาคารออมสินภาค 6'));
    assert.ok(html.includes('1.026112026'), 'version 1.026112026 shown');
    assert.ok(html.includes('btnToggleViewMode'), 'Mobile/Desktop toggle exists');
    assert.ok(html.includes('adminLoginModal'), 'Settings login modal exists');
    assert.ok(html.includes('btnShareLineLightbox') && html.includes('btnShareLineSelected'), 'LINE share buttons exist');
    assert.ok(html.includes('inputEventLogoFile'), 'Event logo upload exists');
    assert.ok(html.includes('viewLanding') && html.includes('inputLandingBgGradient'), 'Landing page and gradient selector exist');
    assert.ok(html.includes('btnToggleFaceBoxes') && html.includes('ดูภาพขนาดเต็ม (Google Drive)'), 'Lightbox face box toggle and Drive button label updated');
    assert.ok(html.includes('btnLightboxPrev') && html.includes('btnLightboxNext'), 'Lightbox left/right navigation exists');
    assert.ok(!html.includes('btnOpenAddFriendModal') && html.includes('addFriendModal') && html.includes('ถ่ายภาพใบหน้า') && html.includes('ใช้ภาพที่มีอยู่'), 'Redundant Add Friend button removed, modal and paired search buttons exist');
    assert.ok(html.includes('similarFacesBox') && html.includes('appDialogModal') && html.includes('inputLandingBgFile') && html.includes('inputLandingExpireDays'), 'Similar faces suggestion, styled dialog, landing bg & expire days exist');
    assert.ok(html.includes('cfgTabBtnDecor') && html.includes('cfgTabBtnAdmin') && html.includes('landingPhotoCountSpan') && html.includes('btnDeletePhotoAdmin'), '2-tab settings, landing photo count, and admin delete exist');
    assert.ok(html.includes('lightboxFaceLayer'), 'Tap-a-Face layer exists');
    console.log('  ✅ 1. UI: version 1.026112026, Mobile/Desktop toggle, Admin Login, LINE Share, Event Logo');

    // 2. Settings Auth & Config
    const unauthCfg = await post('/api/config', { albumTitle: 'Hack' });
    assert.equal(unauthCfg.ok, false);
    const login = await post('/api/auth/login', { password: 'rm6admin' });
    assert.equal(login.ok, true);
    assert.ok(login.token);
    const postAuth = (url, body) => fetch(base + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': login.token },
      body: JSON.stringify(body)
    }).then((r) => r.json());
    const cfg = await postAuth('/api/config', {
      driveFolderUrl: 'https://drive.google.com/drive/folders/1PinkAlbumSharedFolderId123456?usp=sharing',
      searchEngineMode: 'arcface_gemini',
      geminiApiKey: 'dummy',
      eventLogoDataUrl: SAMPLE_JPEG_BASE64,
      bankLogoDataUrl: SAMPLE_JPEG_BASE64,
      landingTitle1: 'งานสัมมนา RM6',
      landingBgGradient: 'sunset_rose',
      landingBgImageUrl: SAMPLE_JPEG_BASE64,
      landingExpireDays: 7
    });
    assert.equal(cfg.driveFolderId, '1PinkAlbumSharedFolderId123456');
    assert.equal(cfg.searchEngineMode, 'arcface_gemini');
    assert.equal(cfg.eventLogoDataUrl, SAMPLE_JPEG_BASE64);
    assert.equal(cfg.bankLogoDataUrl, SAMPLE_JPEG_BASE64);
    assert.equal(cfg.landingTitle1, 'งานสัมมนา RM6');
    assert.equal(cfg.landingBgGradient, 'sunset_rose');
    assert.ok(cfg.landingBgImageUrl.startsWith('/api/avatars/landing_bg_'), 'Landing BG image saved to disk');
    assert.equal(cfg.landingExpireDays, 7);
    await postAuth('/api/config', { searchEngineMode: 'arcface' });
    console.log('  ✅ 2. Config: Auth required, Drive folder ID, engine mode & logo saved');

    // 3. Upload with pre-computed 512-D faces -> 2 people, group photo separated
    const A1 = unitVec(10, 0.05), A2 = unitVec(10, 0.12), B = unitVec(200);
    const up = await post('/api/photos/upload', {
      files: [
        { name: 'g1.jpg', mimeType: 'image/jpeg', dataBase64: SAMPLE_JPEG_BASE64, thumbBase64: SAMPLE_JPEG_BASE64,
          faces: [{ descriptor: A1, box: { x: 1, y: 1, width: 60, height: 60 }, avatarDataUrl: SAMPLE_JPEG_BASE64 }, { descriptor: B, box: { x: 90, y: 1, width: 60, height: 60 }, avatarDataUrl: SAMPLE_JPEG_BASE64 }] },
        { name: 'g2.jpg', mimeType: 'image/jpeg', dataBase64: SAMPLE_JPEG_BASE64, thumbBase64: SAMPLE_JPEG_BASE64,
          faces: [{ descriptor: A2, box: { x: 5, y: 5, width: 60, height: 60 }, avatarDataUrl: SAMPLE_JPEG_BASE64 }] }
      ]
    });
    assert.equal(up.ok, true);
    assert.equal(up.clusters.length, 2);
    assert.equal(up.clusters[0].photoCount, 2);
    assert.ok(up.clusters[0].avatarDataUrl.startsWith('/api/avatars/'), 'avatar extracted to disk URL');

    // Pagination + omitted faces + lazy /faces + avatar & preview ETag streaming + binary upload
    const paged = await (await fetch(`${base}/api/photos?limit=1&offset=0`)).json();
    assert.equal(paged.photos.length, 1);
    assert.equal(paged.totalFiltered, 2);
    assert.equal(paged.hasMore, true);
    assert.equal(paged.photos[0].faces, undefined, 'faces stripped from /api/photos list');

    const lazyFaces = await (await fetch(`${base}/api/photos/${up.addedPhotos[0].id}/faces`)).json();
    assert.equal(lazyFaces.ok, true);
    assert.ok(Array.isArray(lazyFaces.faces) && lazyFaces.faces.length > 0);

    const avResp = await fetch(`${base}${up.clusters[0].avatarDataUrl}`);
    assert.equal(avResp.status, 200);
    const etag = avResp.headers.get('etag');
    assert.ok(etag, 'ETag header set on streamed avatar');
    const av304 = await fetch(`${base}${up.clusters[0].avatarDataUrl}`, { headers: { 'If-None-Match': etag } });
    assert.equal(av304.status, 304, '304 Not Modified works with ETag');

    const sampleBin = Buffer.from(SAMPLE_JPEG_BASE64.split(',')[1], 'base64');
    const binUp = await (await fetch(`${base}/api/photos/upload-binary?name=bin1.jpg&mimeType=image/jpeg`, {
      method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: sampleBin
    })).json();
    assert.equal(binUp.ok, true);
    assert.ok(binUp.photo.previewUrl.includes('/preview'));
    const simResp = await (await fetch(`${base}/api/clusters/${up.clusters[0].id}/similar`)).json();
    assert.equal(simResp.ok, true);
    assert.ok(Array.isArray(simResp.similar));

    const unauthMerge = await post('/api/clusters/merge', { targetClusterId: up.clusters[0].id, sourceClusterId: up.clusters[1].id });
    assert.equal(unauthMerge.ok, false);
    console.log('  ✅ 3. 512-D clustering, disk avatars, pagination, similar-faces API, ETag 304 & binary upload verified');

    // 4. Search by descriptor (ArcFace cosine)
    const s = await post('/api/faces/search', { descriptors: [unitVec(10, 0.08)], threshold: 0.40, engineMode: 'arcface' });
    assert.equal(s.ok, true);
    assert.equal(s.engineUsed, 'arcface_512d');
    assert.equal(s.matchCount, 2);
    assert.ok(s.results[0].matchSimilarity >= 90);
    console.log(`  ✅ 4. ArcFace search matched ${s.matchCount} photos (top ${s.results[0].matchSimilarity}%)`);

    // 5. Tap-a-Face search
    const tapped = await post('/api/faces/search', {
      sourcePhotoId: up.addedPhotos.find((p) => p.name === 'g2.jpg').id, sourceFaceIndex: 0, threshold: 0.40
    });
    assert.equal(tapped.ok, true);
    assert.equal(tapped.matchCount, 2);
    const strangers = await post('/api/faces/search', { descriptors: [unitVec(333)], threshold: 0.40 });
    assert.equal(strangers.matchCount, 0, 'unknown face must not match anyone');
    console.log('  ✅ 5. Tap-a-Face works; stranger returns 0 matches');

    // 6. ZIP & Delete blocked
    const zipResp = await fetch(`${base}/api/photos/download-zip`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: s.results.map((r) => r.id) })
    });
    const zipBuf = Buffer.from(await zipResp.arrayBuffer());
    assert.equal(zipBuf.readUInt32LE(0), 0x04034b50);
    const delResp = await fetch(`${base}/api/photos/${s.results[0].id}`, { method: 'DELETE' });
    assert.equal(delResp.status, 403, 'non-admin photo deletion must be blocked');
    const delAdminResp = await fetch(`${base}/api/photos/${s.results[0].id}`, {
      method: 'DELETE',
      headers: { 'x-admin-token': login.token }
    });
    assert.equal(delAdminResp.status, 200, 'admin photo deletion must succeed');
    console.log('  ✅ 6. ZIP download valid & photo deletion restricted to Admin only');
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function realAlbumTest() {
  const root = path.resolve(__dirname, '..');
  const indexPath = path.join(root, 'data', 'index.json');
  const svc = new ArcFaceService(root);
  if (!fs.existsSync(indexPath) || !svc.hasModelsOnDisk()) {
    console.log('  ⏭️  7. Real-album ArcFace test skipped (no album / models)');
    return;
  }
  const db = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const indexed = db.photos.filter((p) => p.engineVersion === 'arcface_512d' && p.faces.length);
  if (indexed.length < 5) {
    console.log('  ⏭️  7. Real-album test skipped (album not ArcFace-indexed)');
    return;
  }

  try {
    // Live worker on a real original: detection + 512-D embedding
    const p0 = indexed[0];
    const out = await svc.analyzeImage({ imagePath: path.join(root, 'storage', 'originals', p0.origFileName) });
    assert.ok(out.faces.length > 0, 'SCRFD finds faces in a real photo');
    assert.equal(out.faces[0].descriptor.length, 512);
    // Re-embedding the same photo must reproduce stored embeddings (determinism): every live face matches a stored one
    let minBest = 1;
    for (const lf of out.faces) {
      const best = Math.max(...p0.faces.map((sf) => cosineSimilarity(sf.descriptor, lf.descriptor)));
      minBest = Math.min(minBest, best);
    }
    const cos = minBest;
    assert.ok(cos > 0.95, `stored vs live embedding cosine ${cos}`);

    // Real cluster recall: query with one face of the biggest person; should recover most of their photos
    const clusters = recomputeClusters(db.photos, [], 0.42);
    const big = clusters[0];
    const seedPhoto = db.photos.find((p) => p.faces.some((f) => f.clusterId === big.id && f.clusterEligible));
    const seedFace = seedPhoto.faces.find((f) => f.clusterId === big.id && f.clusterEligible);
    const found = searchByFaceVectors(db.photos, [seedFace.descriptor], 0.40);
    const foundIds = new Set(found.map((m) => m.photoId));
    const recall = big.photoIds.filter((id) => foundIds.has(id)).length / big.photoIds.length;
    assert.ok(recall >= 0.85, `recall ${recall}`);
    console.log(`  ✅ 7. Real album: SCRFD+ArcFace live OK (self-cos ${cos.toFixed(3)}), top person ${big.photoCount} photos, search recall ${(recall * 100).toFixed(0)}%, ${found.length} hits`);
  } finally {
    svc.shutdown();
  }
}

(async () => {
  console.log('🧪 RM6 Pink Album tests');
  await apiTests();
  await realAlbumTest();
  console.log('\n🎉 All tests passed!');
})().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
