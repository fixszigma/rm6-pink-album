'use strict';

const https = require('node:https');

/**
 * Gemini Vision AI Face Verification Module
 * - Automatic multi-model failover chain when a model experiences HTTP 503 (high demand) or 429
 * - Remembers the fastest healthy model for 5 minutes to avoid repeated 503 delays
 * - IPv4-forced HTTPS requests with strict timeouts
 * - Filters out { thought: true } reasoning parts on Gemini 3.x models
 */

const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';

const FALLBACK_MODEL_CHAIN = [
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-2.5-flash',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash-lite'
];

const RETIRED_MODELS = new Set([
  'gemini-1.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-001'
]);

let healthyModelCache = {
  model: '',
  expiresAt: 0
};

function normalizeModelName(model) {
  const cleaned = String(model || '').trim().replace(/^models\//, '');
  if (!cleaned || RETIRED_MODELS.has(cleaned)) {
    return DEFAULT_GEMINI_MODEL;
  }
  return cleaned;
}

function stripDataUrlPrefix(b64) {
  const s = String(b64 || '').trim();
  const idx = s.indexOf(',');
  return idx >= 0 ? s.slice(idx + 1) : s;
}

function parseJsonSafely(rawText) {
  if (!rawText) return null;
  const cleaned = String(rawText)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function httpsRequestJson(urlString, { method = 'GET', bodyObj = null, timeoutMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const payloadBuf = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null;

    const headers = { Accept: 'application/json' };
    if (payloadBuf) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['Content-Length'] = String(payloadBuf.length);
    }

    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (err) reject(err);
      else resolve(val);
    };

    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        family: 4
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const rawText = Buffer.concat(chunks).toString('utf8');
          finish(null, { status: res.statusCode || 0, rawText });
        });
        res.on('error', (err) => finish(err));
      }
    );

    const hardTimer = setTimeout(() => {
      req.destroy(new Error(`หมดเวลาเชื่อมต่อ (${Math.round(timeoutMs / 1000)} วิ)`));
    }, timeoutMs);

    req.on('error', (err) => finish(err));
    if (payloadBuf) req.write(payloadBuf);
    req.end();
  });
}

function extractAnswerText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  const answerParts = parts.filter((p) => !p.thought && typeof p.text === 'string');
  if (answerParts.length > 0) {
    return answerParts.map((p) => p.text).join('');
  }
  return parts.map((p) => p.text || '').join('');
}

async function trySingleModelRequest({
  apiKey,
  modelName,
  parts,
  responseJson,
  timeoutMs = 12000
}) {
  const encodedModel = encodeURIComponent(modelName);
  const encodedKey = encodeURIComponent(apiKey);

  const aiStudioUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodedModel}:generateContent?key=${encodedKey}`;
  const vertexUrl = `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodedModel}:generateContent?key=${encodedKey}`;

  const buildGenConfig = (withThinkingLow) => {
    const cfg = { temperature: 0.1 };
    if (responseJson) {
      cfg.responseMimeType = 'application/json';
    }
    if (withThinkingLow && /^gemini-3\.[78]/i.test(modelName)) {
      cfg.thinkingConfig = { thinkingLevel: 'LOW' };
    }
    return cfg;
  };

  let res = await httpsRequestJson(aiStudioUrl, {
    method: 'POST',
    bodyObj: {
      contents: [{ role: 'user', parts }],
      generationConfig: buildGenConfig(true)
    },
    timeoutMs
  });

  if (res.status === 400 && /thinking/i.test(res.rawText)) {
    res = await httpsRequestJson(aiStudioUrl, {
      method: 'POST',
      bodyObj: {
        contents: [{ role: 'user', parts }],
        generationConfig: buildGenConfig(false)
      },
      timeoutMs
    });
  }

  // Only try Vertex AI endpoint if AI Studio specifically rejects an AQ. key as invalid key type
  let providerUsed = 'Google AI Studio';
  if (
    res.status === 400 &&
    String(apiKey).startsWith('AQ.') &&
    /API key not valid/i.test(res.rawText)
  ) {
    providerUsed = 'Vertex AI';
    res = await httpsRequestJson(vertexUrl, {
      method: 'POST',
      bodyObj: {
        contents: [{ role: 'user', parts }],
        generationConfig: buildGenConfig(false)
      },
      timeoutMs
    });
  }

  if (res.status >= 200 && res.status < 300) {
    const data = JSON.parse(res.rawText);
    return {
      ok: true,
      modelUsed: modelName,
      providerUsed,
      textOut: extractAnswerText(data)
    };
  }

  let shortReason = `HTTP ${res.status}`;
  try {
    const errJson = JSON.parse(res.rawText);
    if (errJson?.error?.message) {
      shortReason = errJson.error.message;
    }
  } catch {
    if (res.rawText) shortReason = res.rawText.slice(0, 180);
  }

  // Retryable across backup models if 503 (high demand/overloaded), 429 (model rate limit), or 404 (retired/unavailable)
  const shouldFailoverModel =
    res.status === 503 ||
    res.status === 429 ||
    res.status === 404 ||
    /high demand|overloaded|unavailable|not found|no longer available|resource exhausted/i.test(shortReason);

  // Stop immediately on fatal auth/billing errors (e.g., depleted prepaid credits or invalid API key)
  const isFatalAuthOrBilling =
    /prepayment credits are depleted|API key not valid|API_KEY_INVALID|PERMISSION_DENIED/i.test(shortReason);

  return {
    ok: false,
    status: res.status,
    lastErrorMsg: `${providerUsed} (${modelName}): ${shortReason}`,
    shouldFailoverModel: shouldFailoverModel && !isFatalAuthOrBilling
  };
}

async function generateWithGemini({
  apiKey,
  model,
  parts,
  responseJson = true,
  timeoutMs = 15000
}) {
  const preferred = normalizeModelName(model);
  const now = Date.now();
  const cachedHealthy = (healthyModelCache.model && healthyModelCache.expiresAt > now)
    ? healthyModelCache.model
    : '';

  const modelsToTry = [
    ...new Set([
      ...(cachedHealthy ? [cachedHealthy] : []),
      preferred,
      ...FALLBACK_MODEL_CHAIN
    ])
  ];

  let firstErrorMsg = '';

  for (const modelName of modelsToTry) {
    let attempt;
    try {
      attempt = await trySingleModelRequest({
        apiKey,
        modelName,
        parts,
        responseJson,
        timeoutMs
      });
    } catch (netErr) {
      if (!firstErrorMsg) firstErrorMsg = `${modelName}: ${netErr.message}`;
      continue;
    }

    if (attempt.ok) {
      healthyModelCache = {
        model: attempt.modelUsed,
        expiresAt: Date.now() + 5 * 60 * 1000
      };
      return attempt;
    }

    if (!firstErrorMsg) {
      firstErrorMsg = attempt.lastErrorMsg;
    }

    if (!attempt.shouldFailoverModel) {
      break;
    }
  }

  throw new Error(firstErrorMsg || 'ไม่สามารถเชื่อมต่อ Gemini API ได้ในขณะนี้');
}

async function testGeminiConnection({ apiKey, model = DEFAULT_GEMINI_MODEL }) {
  const cleanKey = String(apiKey || '').trim();
  if (!cleanKey) {
    throw new Error('ยังไม่ได้กรอก Gemini API Key');
  }
  const startedAt = Date.now();
  const res = await generateWithGemini({
    apiKey: cleanKey,
    model,
    parts: [{ text: 'Reply with exact word: OK' }],
    responseJson: false,
    timeoutMs: 10000
  });
  return {
    ok: true,
    modelUsed: res.modelUsed,
    providerUsed: res.providerUsed,
    durationMs: Date.now() - startedAt
  };
}

async function callGeminiBatch({ apiKey, model, queryBase64, queryMimeType, batchCandidates }) {
  const parts = [
    {
      text:
        'You are a high-precision facial identity verifier for an event photo album.\n' +
        'Image 1 is TARGET_PERSON (a close-up of the person we are searching for).\n' +
        'Following TARGET_PERSON are candidate face crops (or event photos), each labeled `PHOTO_ID=<id>`.\n' +
        'Determine for EVERY candidate whether it shows the EXACT SAME individual as TARGET_PERSON.\n' +
        'Compare permanent facial structure carefully: eyes, eye spacing, eyebrows, nose bridge/tip, philtrum, mouth/lips, jawline, and ear/cheekbone proportions. ' +
        'Account for changes in expression (smiling vs neutral), head angle, lighting, or glasses, ' +
        'but STRICTLY REJECT different people of similar age/gender/hairstyle.\n' +
        'Respond ONLY with JSON in this exact schema:\n' +
        '{"matches":[{"photoId":"<id>","isSamePerson":true,"confidence":92}]}\n' +
        'Include an entry for every candidate. Set isSamePerson=true and confidence (68-99) ONLY when it is genuinely the same person.'
    },
    { text: 'TARGET_PERSON:' },
    {
      inlineData: {
        mimeType: queryMimeType || 'image/jpeg',
        data: queryBase64
      }
    }
  ];

  for (const cand of batchCandidates) {
    parts.push({ text: `PHOTO_ID=${cand.id}` });
    parts.push({
      inlineData: {
        mimeType: cand.mimeType || 'image/jpeg',
        data: cand.base64
      }
    });
  }

  const res = await generateWithGemini({
    apiKey,
    model,
    parts,
    responseJson: true,
    timeoutMs: 22000
  });

  const parsed = parseJsonSafely(res.textOut);
  const matches = Array.isArray(parsed?.matches) ? parsed.matches : [];
  return {
    modelUsed: res.modelUsed,
    providerUsed: res.providerUsed,
    matches
  };
}

async function verifyFacesWithGemini({
  apiKey,
  model = DEFAULT_GEMINI_MODEL,
  queryImageBase64,
  queryMimeType = 'image/jpeg',
  candidates = []
}) {
  const cleanKey = String(apiKey || '').trim();
  const queryBase64 = stripDataUrlPrefix(queryImageBase64);
  if (!cleanKey || !queryBase64 || !candidates.length) {
    return { ok: false, matchesMap: new Map() };
  }

  const startedAt = Date.now();
  // Single compact batch of up to 16 top 120x120 face crops (~64 KB total)
  // -> 1 API call per search so Free Tier RPM limits are never exhausted!
  const prepared = candidates.slice(0, 16).map((c) => ({
    id: c.id,
    mimeType: c.mimeType || 'image/jpeg',
    base64: c.base64 ? stripDataUrlPrefix(c.base64) : c.buffer.toString('base64')
  }));

  const matchesMap = new Map();
  const BATCH_SIZE = 16;
  let modelUsed = normalizeModelName(model);
  let providerUsed = '';

  for (let i = 0; i < prepared.length; i += BATCH_SIZE) {
    const chunk = prepared.slice(i, i + BATCH_SIZE);
    const res = await callGeminiBatch({
      apiKey: cleanKey,
      model: modelUsed,
      queryBase64,
      queryMimeType,
      batchCandidates: chunk
    });
    modelUsed = res.modelUsed;
    providerUsed = res.providerUsed;
    for (const item of res.matches) {
      if (!item || !item.photoId) continue;
      matchesMap.set(String(item.photoId), {
        isSamePerson: Boolean(item.isSamePerson),
        confidence: Math.max(0, Math.min(99, Math.round(Number(item.confidence) || 0)))
      });
    }
  }

  return {
    ok: true,
    modelUsed,
    providerUsed,
    durationMs: Date.now() - startedAt,
    matchesMap
  };
}

module.exports = {
  DEFAULT_GEMINI_MODEL,
  FALLBACK_MODEL_CHAIN,
  normalizeModelName,
  verifyFacesWithGemini,
  testGeminiConnection
};
