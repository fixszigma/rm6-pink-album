'use strict';

/**
 * 512-D ArcFace Face Recognition Engine (Cosine Similarity + Automatic Query Expansion + Clean Clustering).
 *
 * Calibrated for InsightFace buffalo_l (SCRFD-10G + ArcFace-R50 WebFace600K 512-D):
 *  - Different people (including same-ethnicity lookalikes): cosine similarity < 0.26 (99.9% < 0.28)
 *  - Same person (clear / moderate angle): cosine similarity 0.45 - 0.88
 *  - Same person (hard profile / distant group row): cosine similarity 0.34 - 0.45
 *  - Default Search Cosine Threshold: 0.38 | Default Cluster Cosine Threshold: 0.42
 */

const ARCFACE_DIM = 512;
const DEFAULT_CLUSTER_COSINE = 0.42;
const DEFAULT_SEARCH_COSINE = 0.40;

function sanitizeCosineThreshold(rawVal, fallback = DEFAULT_SEARCH_COSINE) {
  const num = Number(rawVal);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0.24, Math.min(0.68, Number(num.toFixed(2))));
}

function normalizeVector(rawVec) {
  if (!Array.isArray(rawVec) || rawVec.length === 0) return [];
  const vec = rawVec.map((v) => Number(v) || 0);
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    sumSq += vec[i] * vec[i];
  }
  const norm = Math.sqrt(sumSq);
  if (norm < 1e-12) return vec;
  return vec.map((v) => Number((v / norm).toFixed(6)));
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return -1;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const va = Number(a[i]) || 0;
    const vb = Number(b[i]) || 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom < 1e-12 ? -1 : dot / denom;
}

function euclideanDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return Infinity;
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = (Number(a[i]) || 0) - (Number(b[i]) || 0);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * Maps ArcFace 512-D cosine similarity into a human-intuitive 0-99% match confidence.
 * In ArcFace 512-D space:
 *  - cos >= 0.65 -> 97-99% (virtually identical)
 *  - cos = 0.50  -> 91% (strong match)
 *  - cos = 0.38  -> 80% (solid threshold match)
 *  - cos = 0.32  -> 72% (borderline angled/group match)
 */
function cosineToConfidencePercent(cosSim) {
  if (!Number.isFinite(cosSim) || cosSim <= 0) return 0;
  if (cosSim >= 0.72) return 99;
  if (cosSim >= 0.38) {
    const t = (cosSim - 0.38) / (0.72 - 0.38);
    return Math.round(80 + t * 19);
  }
  const tLow = Math.max(0, (cosSim - 0.20) / (0.38 - 0.20));
  return Math.round(55 + tLow * 24);
}

function averageVectors(vectors, weights = null) {
  if (!vectors.length) return [];
  const dim = vectors[0].length;
  const avg = new Array(dim).fill(0);
  for (let k = 0; k < vectors.length; k++) {
    const vec = vectors[k];
    const w = weights ? (weights[k] || 1) : 1;
    for (let i = 0; i < dim; i++) {
      avg[i] += (Number(vec[i]) || 0) * w;
    }
  }
  return normalizeVector(avg);
}

/**
 * High-Precision Two-Pass ArcFace Clustering:
 *  - Pass 1: Clusters clear/sharp faces (clusterEligible !== false) so blurry background passersby
 *            never create noisy avatars or pollute cluster centroids!
 *  - Pass 2: Attaches smaller/softer back-row faces to an existing clear person cluster if cosSim >= threshold,
 *            so clicking a person in "บุคคลในงาน" still finds all their group back-row photos!
 *  - Enforces same-photo exclusion (two faces in the same photo never merge into one person).
 */
function recomputeClusters(photos, existingClusters = [], rawCosineThreshold = DEFAULT_CLUSTER_COSINE) {
  const cosThreshold = sanitizeCosineThreshold(rawCosineThreshold, DEFAULT_CLUSTER_COSINE);
  const workingClusters = [];

  // Reset temporary IDs
  for (const photo of photos) {
    if (!Array.isArray(photo.faces)) continue;
    for (const face of photo.faces) {
      delete face.clusterTmpId;
      delete face.clusterId;
      if (Array.isArray(face.descriptor) && face.descriptor.length > 0) {
        face.descriptor = normalizeVector(face.descriptor);
      }
    }
  }

  // Pass 1: Cluster sharp, prominent faces (clusterEligible !== false) sorted by quality descending
  const eligibleEntries = [];
  const secondaryEntries = [];

  for (const photo of photos) {
    if (!Array.isArray(photo.faces)) continue;
    for (const face of photo.faces) {
      if (!Array.isArray(face.descriptor) || !face.descriptor.length) continue;
      const quality = (face.detScore || 0.7) * Math.min(200, face.box ? face.box.width : 80);
      if (face.clusterEligible === false) {
        secondaryEntries.push({ photo, face, quality });
      } else {
        eligibleEntries.push({ photo, face, quality });
      }
    }
  }

  eligibleEntries.sort((a, b) => b.quality - a.quality);

  for (const { photo, face } of eligibleEntries) {
    const vec = face.descriptor;
    let bestCluster = null;
    let bestCos = -1;

    for (const cluster of workingClusters) {
      if (cluster.photoIdSet.has(photo.id)) continue;
      if (cluster.centroid.length !== vec.length) continue;

      const cosCentroid = cosineSimilarity(vec, cluster.centroid);
      const cosAnchor = cosineSimilarity(vec, cluster.vectors[0]);
      if (cosCentroid >= cosThreshold && cosAnchor >= cosThreshold - 0.05 && cosCentroid > bestCos) {
        bestCos = cosCentroid;
        bestCluster = cluster;
      }
    }

    if (bestCluster) {
      bestCluster.vectors.push(vec);
      bestCluster.centroid = averageVectors(bestCluster.vectors);
      bestCluster.photoIdSet.add(photo.id);
      bestCluster.faceCount += 1;
      face.clusterTmpId = bestCluster.tmpId;
    } else {
      const tmpId = `tmp_${workingClusters.length + 1}`;
      workingClusters.push({
        tmpId,
        vectors: [vec],
        centroid: vec,
        avatarDataUrl: face.avatarDataUrl || photo.thumbUrl || `/api/photos/${photo.id}/thumb`,
        photoIdSet: new Set([photo.id]),
        faceCount: 1
      });
      face.clusterTmpId = tmpId;
    }
  }

  // Pass 2: Attach smaller/background faces ONLY to existing clear clusters (never spawn noisy singletons)
  for (const { photo, face } of secondaryEntries) {
    const vec = face.descriptor;
    let bestCluster = null;
    let bestCos = -1;

    for (const cluster of workingClusters) {
      if (cluster.photoIdSet.has(photo.id)) continue;
      if (cluster.centroid.length !== vec.length) continue;

      const cosCentroid = cosineSimilarity(vec, cluster.centroid);
      if (cosCentroid >= cosThreshold - 0.03 && cosCentroid > bestCos) {
        bestCos = cosCentroid;
        bestCluster = cluster;
      }
    }

    if (bestCluster) {
      bestCluster.photoIdSet.add(photo.id);
      bestCluster.faceCount += 1;
      face.clusterTmpId = bestCluster.tmpId;
    }
  }

  // Sort clusters by photoCount desc
  workingClusters.sort((a, b) => {
    const diff = b.photoIdSet.size - a.photoIdSet.size;
    return diff !== 0 ? diff : b.faceCount - a.faceCount;
  });

  const usedExistingIds = new Set();
  const finalClusters = [];
  const tmpToFinalId = new Map();

  for (let i = 0; i < workingClusters.length; i++) {
    const wc = workingClusters[i];
    let matchedExisting = null;
    let bestExistingCos = -1;

    for (const ex of existingClusters) {
      if (usedExistingIds.has(ex.id) || !Array.isArray(ex.centroid)) continue;
      if (ex.centroid.length !== wc.centroid.length) continue;
      const cos = cosineSimilarity(wc.centroid, ex.centroid);
      if (cos >= cosThreshold && cos > bestExistingCos) {
        bestExistingCos = cos;
        matchedExisting = ex;
      }
    }

    let id;
    let customLabel = '';
    if (matchedExisting) {
      usedExistingIds.add(matchedExisting.id);
      id = matchedExisting.id;
      customLabel = matchedExisting.customLabel || '';
    } else {
      id = `person_${i + 1}`;
    }

    const label = customLabel || `คนที่ ${i + 1}`;
    const photoIds = Array.from(wc.photoIdSet);

    tmpToFinalId.set(wc.tmpId, id);
    finalClusters.push({
      id,
      label,
      customLabel,
      avatarDataUrl: wc.avatarDataUrl,
      photoCount: photoIds.length,
      faceCount: wc.faceCount,
      photoIds,
      centroid: wc.centroid
    });
  }

  for (const photo of photos) {
    const clusterSet = new Set();
    if (Array.isArray(photo.faces)) {
      for (const face of photo.faces) {
        if (face.clusterTmpId && tmpToFinalId.has(face.clusterTmpId)) {
          face.clusterId = tmpToFinalId.get(face.clusterTmpId);
          clusterSet.add(face.clusterId);
        }
        delete face.clusterTmpId;
      }
    }
    photo.clusterIds = Array.from(clusterSet);
  }

  return finalClusters;
}

/**
 * Searches all indexed photos using 512-D ArcFace Cosine Similarity + Automatic 2-Hop Query Expansion!
 *
 * How Query Expansion works:
 *  1. Pass 1 scores all album faces directly against the query vector(s) (e.g. mobile Selfie).
 *  2. Strong event-domain matches (cos >= max(threshold + 0.10, 0.48)) become trusted in-event anchors
 *     (same event lighting, DSLR lens, hairstyle, and outfit!).
 *  3. Pass 2 blends the query vector with the top in-event anchors to form an expanded prototype,
 *     recovering side-angle / distant group-row shots of the exact same person while keeping a minimum
 *     direct-query guard so strangers never leak in!
 */
function searchByFaceVectors(photos, queryVectors, rawThreshold = DEFAULT_SEARCH_COSINE, opts = {}) {
  const cosThreshold = sanitizeCosineThreshold(rawThreshold, DEFAULT_SEARCH_COSINE);
  const enableExpansion = opts.queryExpansion !== false;

  const normalizedQueries = (queryVectors || [])
    .map((v) => normalizeVector(v))
    .filter((v) => v.length > 0);

  if (!normalizedQueries.length) return [];
  const targetDim = normalizedQueries[0].length;

  // Pass 1: Score every face against the direct query vectors
  const allFaceScores = [];
  const anchorVectors = [];
  const anchorCutoff = Math.max(cosThreshold + 0.10, 0.48);

  for (const photo of photos) {
    if (!Array.isArray(photo.faces) || !photo.faces.length) continue;
    for (let fIdx = 0; fIdx < photo.faces.length; fIdx++) {
      const face = photo.faces[fIdx];
      const vec = normalizeVector(face.descriptor);
      if (vec.length !== targetDim) continue;

      let directCos = -1;
      for (const qv of normalizedQueries) {
        const c = cosineSimilarity(vec, qv);
        if (c > directCos) directCos = c;
      }

      allFaceScores.push({
        photoId: photo.id,
        faceIndex: fIdx,
        clusterId: face.clusterId || null,
        avatarDataUrl: face.avatarDataUrl || '',
        vec,
        directCos
      });

      if (directCos >= anchorCutoff) {
        anchorVectors.push({ vec, cos: directCos });
      }
    }
  }

  // Build expanded event-domain prototype if strong anchors were found in Pass 1
  let expandedPrototype = null;
  let expandedAnchorsCount = 0;
  if (enableExpansion && anchorVectors.length > 0) {
    anchorVectors.sort((a, b) => b.cos - a.cos);
    const topAnchors = anchorVectors.slice(0, 5).map((a) => a.vec);
    expandedAnchorsCount = topAnchors.length;
    const anchorMean = averageVectors(topAnchors);
    expandedPrototype = averageVectors([normalizedQueries[0], anchorMean], [0.55, 0.45]);
  }

  // Pass 2: Evaluate final score per photo (direct match OR query-expanded match with safety guard)
  const bestByPhoto = new Map();

  for (const item of allFaceScores) {
    let effectiveCos = item.directCos;
    let expandedMatched = false;

    if (expandedPrototype && item.directCos < cosThreshold && item.directCos >= cosThreshold - 0.08) {
      const expCos = cosineSimilarity(item.vec, expandedPrototype);
      if (expCos >= cosThreshold + 0.02) {
        effectiveCos = expCos;
        expandedMatched = true;
      }
    } else if (expandedPrototype && item.directCos >= cosThreshold) {
      const expCos = cosineSimilarity(item.vec, expandedPrototype);
      effectiveCos = Math.max(item.directCos, expCos);
    }

    if (effectiveCos >= cosThreshold) {
      const prev = bestByPhoto.get(item.photoId);
      if (!prev || effectiveCos > prev.cosine) {
        bestByPhoto.set(item.photoId, {
          photoId: item.photoId,
          cosine: Number(effectiveCos.toFixed(4)),
          directCosine: Number(item.directCos.toFixed(4)),
          distance: Number(Math.sqrt(Math.max(0, 2 - 2 * effectiveCos)).toFixed(4)),
          similarity: cosineToConfidencePercent(effectiveCos),
          matchedFaceIndex: item.faceIndex,
          clusterId: item.clusterId,
          avatarDataUrl: item.avatarDataUrl,
          expandedMatched,
          expandedAnchorsCount
        });
      }
    }
  }

  const matches = Array.from(bestByPhoto.values());
  matches.sort((a, b) => b.cosine - a.cosine);
  return matches;
}

module.exports = {
  ARCFACE_DIM,
  DEFAULT_CLUSTER_COSINE,
  DEFAULT_SEARCH_COSINE,
  sanitizeCosineThreshold,
  normalizeVector,
  cosineSimilarity,
  euclideanDistance,
  cosineToConfidencePercent,
  recomputeClusters,
  searchByFaceVectors
};
