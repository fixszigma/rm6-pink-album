'use strict';

// Re-indexes every photo in data/index.json with InsightFace (SCRFD + ArcFace 512-D) and prints quality stats.
const fs = require('node:fs');
const path = require('node:path');
const { ArcFaceService } = require('../lib/arcface-client');
const { normalizeVector, recomputeClusters, cosineSimilarity } = require('../lib/face-engine');

(async () => {
  const root = path.resolve(__dirname, '..');
  const indexPath = path.join(root, 'data', 'index.json');
  const originalsDir = path.join(root, 'storage', 'originals');
  const thumbsDir = path.join(root, 'storage', 'thumbs');
  const db = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

  const svc = new ArcFaceService(root);
  const t0 = Date.now();
  await svc.ensureStarted();
  console.log('worker ready in', Date.now() - t0, 'ms');

  const items = db.photos
    .filter((p) => p.origFileName && fs.existsSync(path.join(originalsDir, p.origFileName)))
    .map((p) => ({
      id: p.id,
      imagePath: path.join(originalsDir, p.origFileName),
      saveThumbPath: path.join(thumbsDir, p.thumbFileName || `${p.id}_thumb.jpg`)
    }));

  const byId = new Map(db.photos.map((p) => [p.id, p]));
  const CHUNK = 6;
  for (let i = 0; i < items.length; i += CHUNK) {
    const slice = items.slice(i, i + CHUNK);
    const out = await svc.analyzeBatchPaths(slice, 240000);
    for (const it of slice) {
      const r = out.results[it.id];
      const p = byId.get(it.id);
      if (!r || !p) continue;
      p.width = r.width;
      p.height = r.height;
      p.thumbFileName = p.thumbFileName || `${p.id}_thumb.jpg`;
      p.faces = r.faces.map((f) => ({
        descriptor: normalizeVector(f.descriptor),
        box: f.box,
        detScore: f.detScore,
        blurScore: f.blurScore,
        clusterEligible: f.clusterEligible,
        avatarDataUrl: f.avatarDataUrl
      }));
      p.faceIndexed = true;
      p.engineVersion = 'arcface_512d';
    }
    console.log(`indexed ${Math.min(i + CHUNK, items.length)}/${items.length}`);
  }

  db.clusters = recomputeClusters(db.photos, [], 0.42);
  db.updatedAt = new Date().toISOString();
  fs.writeFileSync(indexPath, JSON.stringify(db, null, 2), 'utf8');

  let faces = 0, eligible = 0;
  for (const p of db.photos) for (const f of p.faces) { faces++; if (f.clusterEligible) eligible++; }
  const sameDists = [];
  for (const p of db.photos) {
    for (let i = 0; i < p.faces.length; i++) for (let j = i + 1; j < p.faces.length; j++) {
      sameDists.push(cosineSimilarity(p.faces[i].descriptor, p.faces[j].descriptor));
    }
  }
  sameDists.sort((a, b) => b - a);
  console.log({
    photos: db.photos.length, faces, eligible,
    clusters: db.clusters.length,
    multiPhoto: db.clusters.filter((c) => c.photoCount >= 2).length,
    top: db.clusters.slice(0, 8).map((c) => c.photoCount),
    differentPeopleSamePhotoCosine: { max: +sameDists[0].toFixed(3), p99: +sameDists[Math.floor(sameDists.length * 0.01)].toFixed(3), p90: +sameDists[Math.floor(sameDists.length * 0.1)].toFixed(3) },
    totalMs: Date.now() - t0
  });
  svc.shutdown();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
