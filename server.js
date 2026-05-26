import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const UPSTREAM = process.env.UPSTREAM || 'https://api.example.com';
const PORT = Number(process.env.PORT || 8080);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMAGE_JOB_DIR = process.env.IMAGE_JOB_DIR || path.join(__dirname, '.image-jobs');
const IMAGE_JOB_TTL_MS = Number(process.env.IMAGE_JOB_TTL_MS || 24 * 60 * 60 * 1000);
const MAX_IMAGE_RESPONSE_BYTES = Number(process.env.MAX_IMAGE_RESPONSE_BYTES || 80 * 1024 * 1024);

const app = express();

app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html') || req.path.endsWith('.js')) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
  }
  next();
});

app.get('/api/config', (_req, res) => {
  res.json({
    videoBase: 'api/video',
    imageBase: 'api/image',
    videoUpstream: UPSTREAM,
    imageUpstream: UPSTREAM,
    hasServerVideoToken: false,
    hasServerImageToken: false,
    imageConfigured: true,
    webSearchEnabled: true,
    imageSearchEnabled: true,
    imageSearchSources: ['wikimedia'],
  });
});

app.get('/api/check', async (_req, res) => {
  const t0 = Date.now();
  try {
    // HEAD /v1/models — 不带 token 会 401，但说明上游可达；只是测连通性
    const r = await httpHead(UPSTREAM.replace(/\/$/, '') + '/v1/models');
    const latencyMs = Date.now() - t0;
    res.json({
      ok: r.status > 0 && r.status < 500,
      configured: true,
      status: r.status,
      latencyMs,
      upstream: UPSTREAM,
    });
  } catch (e) {
    res.json({
      ok: false,
      configured: true,
      status: 0,
      latencyMs: Date.now() - t0,
      upstream: UPSTREAM,
      error: e.message,
    });
  }
});

function httpHead(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'HEAD',
      headers: { 'User-Agent': 'zaoyin/1.0', ...headers },
      timeout: 5000,
    }, (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

const proxy = createProxyMiddleware({
  target: UPSTREAM,
  changeOrigin: true,
  pathRewrite: { '^/api/(llm|image|video)': '' },
  xfwd: true,
});

function videoBearerFromRequest(req) {
  const fromHeader = req.headers.authorization || '';
  if (/^Bearer\s+/i.test(fromHeader)) return fromHeader;
  const token = String(req.query._token || '').trim();
  if (!token) return '';
  return /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}

function videoProxyJsonError(res, status, message, extra = {}) {
  if (res.headersSent) return;
  res.status(status).json({
    error: {
      message,
      type: 'server_error',
      ...extra,
    },
  });
}

function jsonError(res, status, message, extra = {}) {
  if (res.headersSent || res.destroyed) return;
  res.status(status).json({ ok: false, error: message, ...extra });
}

function safeJobId(id) {
  const s = String(id || '').trim();
  if (!/^[a-zA-Z0-9_-]{6,80}$/.test(s)) throw new Error('bad job id');
  return s;
}

function authHashFromHeader(header) {
  const auth = String(header || '').trim();
  if (!auth) return '';
  return crypto.createHash('sha256').update(auth).digest('hex');
}

function imageJobPath(id) {
  return path.join(IMAGE_JOB_DIR, `${safeJobId(id)}.json`);
}

function isAllowedImagePath(p) {
  return /^\/v1\/images\/(generations|edits)$/.test(p) || /^\/v1beta\/models\/[^/]+:generateContent$/.test(p);
}

async function cleanupImageJobs() {
  const now = Date.now();
  let names = [];
  try { names = await fs.readdir(IMAGE_JOB_DIR); } catch { return; }
  await Promise.all(names.map(async (name) => {
    if (!name.endsWith('.json')) return;
    const p = path.join(IMAGE_JOB_DIR, name);
    try {
      const st = await fs.stat(p);
      if (now - st.mtimeMs > IMAGE_JOB_TTL_MS) await fs.rm(p, { force: true });
    } catch {}
  }));
}

async function writeImageJob(ids, record) {
  await fs.mkdir(IMAGE_JOB_DIR, { recursive: true });
  const payload = JSON.stringify(record);
  await Promise.all([...new Set(ids)].map(async (id) => {
    try { await fs.writeFile(imageJobPath(id), payload); } catch (e) { console.warn('image job write failed', e.message); }
  }));
  cleanupImageJobs().catch(() => {});
}

async function readImageJob(id, authHash = '') {
  const p = imageJobPath(id);
  const text = await fs.readFile(p, 'utf8');
  const record = JSON.parse(text);
  if (Date.now() - (record.savedAt || 0) > IMAGE_JOB_TTL_MS) {
    await fs.rm(p, { force: true });
    return null;
  }
  if (record.authHash && record.authHash !== authHash) return null;
  return record;
}

async function writeRecentImageJob(record) {
  const id = `recent-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  await writeImageJob([id], record);
  return id;
}

function textSimilarityNeedle(s) {
  return String(s || '').trim().replace(/\s+/g, '').slice(0, 120);
}

async function findRecentImageJob({ createdAt, model, prompt, authHash }) {
  let names = [];
  try { names = await fs.readdir(IMAGE_JOB_DIR); } catch { return null; }
  const created = Number(createdAt) || 0;
  const needle = textSimilarityNeedle(prompt);
  const rows = [];
  for (const name of names) {
    if (!name.startsWith('recent-') || !name.endsWith('.json')) continue;
    try {
      const record = await readImageJob(name.replace(/\.json$/, ''), authHash);
      if (!record) continue;
      const req = record.request || {};
      if (model && req.model && String(req.model) !== String(model)) continue;
      if (needle && !textSimilarityNeedle(req.prompt).includes(needle.slice(0, 60))) continue;
      const delta = created ? Math.abs((record.savedAt || 0) - created) : 0;
      if (created && delta > 15 * 60 * 1000) continue;
      rows.push({ record, delta });
    } catch {}
  }
  rows.sort((a, b) => a.delta - b.delta);
  return rows[0]?.record || null;
}

function httpPostJson(urlStr, body, headers = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const data = Buffer.from(JSON.stringify(body || {}));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'POST',
      headers: {
        'User-Agent': 'zaoyin/1.0',
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        ...headers,
      },
      timeout: 10 * 60 * 1000,
    }, (upstreamRes) => {
      const chunks = [];
      let bytes = 0;
      upstreamRes.on('data', (c) => {
        bytes += c.length;
        if (bytes > MAX_IMAGE_RESPONSE_BYTES) {
          req.destroy(new Error('image response too large'));
          return;
        }
        chunks.push(c);
      });
      upstreamRes.on('end', () => resolve({
        status: upstreamRes.statusCode || 502,
        headers: upstreamRes.headers,
        body: Buffer.concat(chunks),
      }));
      upstreamRes.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end(data);
  });
}

async function runImageRequest({ imagePath, body, authHeader, localIds = [] }) {
  const upstream = UPSTREAM.replace(/\/$/, '') + imagePath;
  const upstreamResp = await httpPostJson(upstream, body || {}, authHeader ? { Authorization: authHeader } : {});
  const contentType = String(upstreamResp.headers['content-type'] || 'application/json');
  const responseText = upstreamResp.body.toString('utf8');
  const record = {
    savedAt: Date.now(),
    status: upstreamResp.status,
    contentType,
    body: responseText,
    authHash: authHashFromHeader(authHeader),
    request: {
      path: imagePath,
      model: body?.model || body?.__model || '',
      prompt: body?.prompt || body?.contents?.[0]?.parts?.find?.(p => p.text)?.text || '',
    },
  };

  if (upstreamResp.status >= 200 && upstreamResp.status < 300) {
    if (localIds.length) await writeImageJob(localIds, record);
    await writeRecentImageJob(record);
  }

  return { ...record, responseText };
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function copyProxyHeaders(src, res) {
  for (const [key, value] of Object.entries(src.headers || {})) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    if (value !== undefined) res.setHeader(key, value);
  }
}

function validatePublicHttpUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch {
    throw new Error('bad video url');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('bad video protocol');
  if (isPrivateHost(u.hostname)) throw new Error('private video host blocked');
  return u.toString();
}

function streamGet(urlStr, headers, res, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'GET',
      headers: { 'User-Agent': 'zaoyin/1.0', Accept: '*/*', ...headers },
      timeout: 60000,
    }, async (upstreamRes) => {
      if ([301, 302, 303, 307, 308].includes(upstreamRes.statusCode) && upstreamRes.headers.location && redirectsLeft > 0) {
        upstreamRes.resume();
        try {
          const next = new URL(upstreamRes.headers.location, u).toString();
          const r2 = await streamGet(next, headers, res, redirectsLeft - 1);
          return resolve(r2);
        } catch (e) { return reject(e); }
      }

      if (![200, 206].includes(upstreamRes.statusCode)) {
        const chunks = [];
        let bytes = 0;
        upstreamRes.on('data', (c) => {
          bytes += c.length;
          if (bytes <= 8192) chunks.push(c);
        });
        upstreamRes.on('end', () => resolve({
          ok: false,
          status: upstreamRes.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
        upstreamRes.on('error', reject);
        return;
      }

      copyProxyHeaders(upstreamRes, res);
      if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'public, max-age=86400');
      res.status(upstreamRes.statusCode);
      upstreamRes.pipe(res);
      upstreamRes.on('end', () => resolve({ ok: true, status: upstreamRes.statusCode }));
      upstreamRes.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

app.get('/api/video/v1/videos/:taskId/content', async (req, res) => {
  const auth = videoBearerFromRequest(req);
  if (!auth) {
    videoProxyJsonError(res, 401, 'Missing video token');
    return;
  }

  const taskId = encodeURIComponent(req.params.taskId);
  const upstream = UPSTREAM.replace(/\/$/, '');
  const rangeHeaders = req.headers.range ? { Range: req.headers.range } : {};

  try {
    const content = await streamGet(`${upstream}/v1/videos/${taskId}/content`, {
      Authorization: auth,
      ...rangeHeaders,
    }, res);
    if (content.ok || res.headersSent) return;

    const metaResp = await httpGet(`${upstream}/v1/videos/${taskId}`, { Authorization: auth });
    if (metaResp.status >= 400) {
      videoProxyJsonError(res, metaResp.status, `Failed to resolve video metadata (${metaResp.status})`);
      return;
    }

    let meta;
    try { meta = JSON.parse(metaResp.body.toString('utf8')); } catch {
      videoProxyJsonError(res, 502, 'Failed to parse video metadata');
      return;
    }

    const directUrl = meta.video_url || meta.metadata?.url || meta.metadata?.video_url;
    if (!directUrl) {
      videoProxyJsonError(res, content.status || 502, 'Video content unavailable', {
        upstream_status: content.status,
      });
      return;
    }

    let safeDirectUrl;
    try {
      safeDirectUrl = validatePublicHttpUrl(directUrl);
    } catch (e) {
      videoProxyJsonError(res, 502, e.message);
      return;
    }

    const direct = await streamGet(safeDirectUrl, rangeHeaders, res);
    if (!direct.ok && !res.headersSent) {
      videoProxyJsonError(res, 502, `Video file unavailable (${direct.status || 'unknown'})`, {
        upstream_status: direct.status,
      });
    }
  } catch (e) {
    videoProxyJsonError(res, 502, 'Failed to fetch video content', { detail: e.message });
  }
});

app.post('/api/image-job', express.json({ limit: '80mb' }), async (req, res) => {
  const imagePath = String(req.body?.path || '');
  if (!isAllowedImagePath(imagePath)) {
    jsonError(res, 400, 'bad image path');
    return;
  }

  const localIds = Array.isArray(req.body?.localIds)
    ? req.body.localIds.map(id => String(id || '')).filter(Boolean)
    : [];

  let safeIds = [];
  try {
    safeIds = localIds.map(safeJobId);
  } catch {
    jsonError(res, 400, 'bad job id');
    return;
  }

  try {
    const result = await runImageRequest({
      imagePath,
      body: req.body?.body || {},
      authHeader: req.headers.authorization || '',
      localIds: safeIds,
    });

    res.status(result.status);
    res.setHeader('Content-Type', result.contentType);
    res.send(result.responseText);
  } catch (e) {
    jsonError(res, 502, 'image job failed', { detail: e.message });
  }
});

app.get('/api/image-job/:localId', async (req, res) => {
  try {
    const record = await readImageJob(req.params.localId, authHashFromHeader(req.headers.authorization));
    if (!record) {
      jsonError(res, 404, 'image job expired');
      return;
    }
    res.json({ ok: true, ...record });
  } catch {
    jsonError(res, 404, 'image job not found');
  }
});

app.get('/api/image-job-recent', async (req, res) => {
  const record = await findRecentImageJob({
    createdAt: req.query.createdAt,
    model: req.query.model,
    prompt: req.query.prompt,
    authHash: authHashFromHeader(req.headers.authorization),
  });
  if (!record) {
    jsonError(res, 404, 'image job not found');
    return;
  }
  res.json({ ok: true, ...record });
});

app.post('/api/image/v1/images/:op(generations|edits)', express.json({ limit: '80mb' }), async (req, res) => {
  try {
    const result = await runImageRequest({
      imagePath: `/v1/images/${req.params.op}`,
      body: req.body || {},
      authHeader: req.headers.authorization || '',
      localIds: [],
    });
    res.status(result.status);
    res.setHeader('Content-Type', result.contentType);
    res.send(result.responseText);
  } catch (e) {
    jsonError(res, 502, 'image proxy failed', { detail: e.message });
  }
});

app.use(['/api/llm', '/api/image', '/api/video'], proxy);

// ---------- search 后端：DuckDuckGo + Wikimedia Commons ----------

function httpGet(urlStr, headers = {}, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; zaoyin/1.0; self-hosted)',
        'Accept': '*/*',
        ...headers,
      },
    }, async (res) => {
      // follow redirect
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        try {
          const next = new URL(res.headers.location, u).toString();
          const r2 = await httpGet(next, headers, redirectsLeft - 1);
          return resolve(r2);
        } catch (e) { return reject(e); }
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

const stripHtml = s => String(s || '')
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ')
  .trim();

// /api/search/web — DuckDuckGo HTML 抓取
app.get('/api/search/web', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const max = Math.min(20, Math.max(1, Number(req.query.max) || 10));
  if (!q) return res.json({ ok: false, error: 'missing q', count: 0, results: [] });
  try {
    const r = await httpGet(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`);
    const html = r.body.toString('utf8');
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,500}?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const results = [];
    let m;
    while ((m = re.exec(html)) && results.length < max) {
      let urlRaw = m[1];
      // DDG wraps real URL in /l/?uddg=...
      const um = urlRaw.match(/[?&]uddg=([^&]+)/);
      if (um) urlRaw = decodeURIComponent(um[1]);
      results.push({
        title: stripHtml(m[2]),
        url: urlRaw,
        snippet: stripHtml(m[3]),
        source: 'ddg',
      });
    }
    res.json({ ok: true, query: q, count: results.length, results });
  } catch (e) {
    res.json({ ok: false, error: e.message, count: 0, results: [] });
  }
});

// /api/search/images — Wikimedia Commons API
app.get('/api/search/images', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const count = Math.min(20, Math.max(1, Number(req.query.count) || 10));
  if (!q) return res.json({ ok: false, error: 'missing q', results: [] });
  try {
    const u = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(q)}&gsrlimit=${count}&prop=imageinfo&iiprop=url%7Csize%7Cmime%7Cextmetadata&iiurlwidth=400&format=json&origin=*`;
    // Wikimedia policy requires contact info in UA
    const r = await httpGet(u, { 'User-Agent': 'zaoyin/1.0 (self-hosted instance)' });
    const data = JSON.parse(r.body.toString('utf8'));
    const pages = Object.values(data.query?.pages || {}).filter(p => Array.isArray(p.imageinfo) && p.imageinfo[0]);
    pages.sort((a, b) => (a.index || 0) - (b.index || 0));
    const results = pages.map(p => {
      const info = p.imageinfo[0];
      const meta = info.extmetadata || {};
      const author = meta.Artist?.value ? stripHtml(meta.Artist.value) : '';
      return {
        source: 'wikimedia',
        id: String(p.pageid),
        title: p.title.replace(/^File:/, ''),
        url: info.url,
        thumb: info.thumburl || info.url,
        full: info.url,
        width: info.width,
        height: info.height,
        author,
      };
    });
    res.json({ ok: true, query: q, count: results.length, results });
  } catch (e) {
    res.json({ ok: false, error: e.message, results: [] });
  }
});

// /api/search/fetch_image — 服务端代下，转 data: URL
const isPrivateHost = h => /^(localhost|127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|::1|fe80:|fd|fc)/i.test(h);

app.get('/api/search/fetch_image', async (req, res) => {
  const target = String(req.query.url || '');
  if (!target) return res.status(400).json({ ok: false, error: 'missing url' });
  let u;
  try { u = new URL(target); } catch { return res.status(400).json({ ok: false, error: 'bad url' }); }
  if (!['http:', 'https:'].includes(u.protocol)) return res.status(400).json({ ok: false, error: 'bad protocol' });
  if (isPrivateHost(u.hostname)) return res.status(403).json({ ok: false, error: 'private host blocked' });
  try {
    const r = await httpGet(target, { Referer: u.origin });
    if (r.status >= 400) return res.json({ ok: false, error: `upstream ${r.status}` });
    const ct = (r.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
    if (!ct.startsWith('image/')) return res.json({ ok: false, error: `not image: ${ct}` });
    res.json({
      ok: true,
      data_url: `data:${ct};base64,${r.body.toString('base64')}`,
      bytes: r.body.length,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.use(express.static(__dirname, { extensions: ['html'] }));

app.listen(PORT, () => {
  console.log(`zaoyin running at http://localhost:${PORT}  ->  ${UPSTREAM}`);
});
