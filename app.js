/* ============================================================
   Atelier — frontend logic
   ============================================================ */

import { Tasks, KV, Blobs, migrateFromLocalStorage, wipeAll } from './storage.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

// ---------- 设置 ----------
const settings = {
  videoToken: '',
  imageToken: '',
  autoPoll: true,
  autoVault: true,
  llmEnabled: false,
  // 兼容旧字段（迁移时使用）
  llmBase: '',
  llmKey: '',
  llmModel: '',
  llmPersona: '',
  llmProtocol: 'chat_completions',
  // 新：多个配置
  llmProfiles: [],           // [{ id, name, protocol, base, key, model, persona }]
  activeProfileId: '',
  queueView: 'list',
  theme: 'auto',
  refAutoCompress: true,         // 自动压缩参考图（保守模式）
  refMaxDim: 3072,               // 最长边（保留更多细节）
  refMaxBytes: 4 * 1024 * 1024,  // 仅当文件 > 4MB 才触发压缩
  refJpegQuality: 0.92,          // 保守质量
};

// 启动时迁移旧字段 → 默认 profile
function migrateLegacyLlmFields() {
  if (!Array.isArray(settings.llmProfiles)) settings.llmProfiles = [];
  if (settings.llmProfiles.length === 0 && (settings.llmBase || settings.llmKey || settings.llmModel)) {
    const p = {
      id: 'pf' + Date.now().toString(36),
      name: settings.llmModel || '默认配置',
      protocol: settings.llmProtocol || 'chat_completions',
      base: settings.llmBase || '',
      key: settings.llmKey || '',
      model: getActiveLlmConfig().model || '',
      persona: settings.llmPersona || '',
    };
    settings.llmProfiles.push(p);
    settings.activeProfileId = p.id;
  }
  if (settings.llmProfiles.length && !settings.llmProfiles.find(p => p.id === settings.activeProfileId)) {
    settings.activeProfileId = settings.llmProfiles[0].id;
  }
}

function getActiveProfile() {
  return settings.llmProfiles.find(p => p.id === settings.activeProfileId) || null;
}
function getActiveLlmConfig() {
  const p = getActiveProfile();
  if (p) return {
    protocol: p.protocol || 'chat_completions',
    base: p.base || '',
    key: p.key || '',
    model: p.model || '',
    persona: p.persona || '',
    contextWindow: p.contextWindow || 'all',  // 'all' | number
    contextLimit: p.contextLimit || 32000,    // token 上限（用于显示）
    thinkingMode: p.thinkingMode || 'auto',   // 'auto' | 'off' | 'low' | 'medium' | 'high'
  };
  return {
    protocol: settings.llmProtocol || 'chat_completions',
    base: settings.llmBase || '', key: settings.llmKey || '', model: settings.llmModel || '',
    persona: settings.llmPersona || '',
    contextWindow: 'all', contextLimit: 32000, thinkingMode: 'auto',
  };
}

function llmReady() {
  if (!settings.llmEnabled) return false;
  const c = getActiveLlmConfig();
  return !!(c.base && c.key && c.model);
}

async function loadSettings() {
  const stored = await KV.get('settings', null);
  if (stored && typeof stored === 'object') Object.assign(settings, stored);
}
async function saveSettings() {
  await KV.put('settings', { ...settings });
}

// ---------- 任务缓存（in-memory mirror，渲染用） ----------
let tasks = [];        // 与 IndexedDB 同步
let editionNo = 0;

async function reloadTasks(opts = {}) {
  tasks = await Tasks.list();
  await normalizeLoadedTasks();
  if (opts.recover) {
    await restoreImageJobs();
    markStaleImageTasks();
  }
}
async function persistTask(t) {
  await Tasks.put(t);
}
function saveTaskAsync(t) {
  // 在循环 / 轮询里不想 await，但仍要把脏数据写下去
  Tasks.put(t).catch(err => console.warn('persist failed', err));
}
async function updateTask(task, patch = {}) {
  Object.assign(task, patch);
  await persistTask(task);
  return task;
}
async function loadEdition() {
  editionNo = (await KV.get('edition', 0)) || 0;
}
async function bumpEdition() {
  editionNo += 1;
  await KV.put('edition', editionNo);
  return editionNo;
}
function pad3(n) { return String(n).padStart(3, '0'); }

// 视频下载 URL — 因为浏览器 <video>/<a> 不带 Authorization，把 token 拼成 query
function videoContentUrl(taskId) {
  const token = settings.videoToken;
  return `api/video/v1/videos/${taskId}/content${token ? `?_token=${encodeURIComponent(token)}` : ''}`;
}

function videoBlobId(task) {
  return task?.videoBlobId || (task?.localId ? `video:${task.localId}` : '');
}

const videoObjectUrls = new Set();
window.addEventListener('beforeunload', () => {
  for (const url of videoObjectUrls) URL.revokeObjectURL(url);
  videoObjectUrls.clear();
});

function createVideoObjectUrl(blob) {
  const url = URL.createObjectURL(blob);
  videoObjectUrls.add(url);
  return url;
}

function setManagedVideoSrc(video, src, objectUrl = '') {
  if (video.dataset.objectUrl) {
    URL.revokeObjectURL(video.dataset.objectUrl);
    videoObjectUrls.delete(video.dataset.objectUrl);
    delete video.dataset.objectUrl;
  }
  video.src = src;
  if (objectUrl) video.dataset.objectUrl = objectUrl;
}

async function getCachedVideoBlob(task) {
  const id = videoBlobId(task);
  if (!id) return null;
  const blob = await Blobs.get(id);
  return blob instanceof Blob ? blob : null;
}

function videoCacheLabel(task) {
  if (!task.videoBlobId) return '未保存到本机';
  const size = task.videoBytes ? ` · ${fmtBytes(task.videoBytes)}` : '';
  return `已保存到本机${size}`;
}

function videoDownloadName(task) {
  return `atelier-${pad3(task.folio)}.mp4`;
}

function ensureVideoTask(task) {
  if (!task || task.kind !== 'video' || task.status !== 'completed' || !task.taskId) {
    throw new Error('视频尚未完成');
  }
}

async function fetchVideoBlobFromNetwork(task) {
  if (task.videoUrl) {
    try {
      const direct = await fetch(task.videoUrl);
      if (direct.ok) return direct.blob();
    } catch {}
  }

  const proxied = await apiFetch('video', `/v1/videos/${task.taskId}/content`, { method: 'GET', kind: 'video' });
  if (!proxied.ok) {
    if (proxied.status === 404) throw new Error('视频源文件已过期');
    throw new Error('视频源暂时不可用（HTTP ' + proxied.status + '）');
  }
  return proxied.blob();
}

async function ensureVideoCached(task, opts = {}) {
  ensureVideoTask(task);
  const existing = await getCachedVideoBlob(task);
  if (existing) {
    if (!task.videoBlobId) {
      task.videoBlobId = videoBlobId(task);
      task.videoMime = existing.type || task.videoMime || 'video/mp4';
      task.videoBytes = existing.size || task.videoBytes || 0;
      await persistTask(task);
    }
    return existing;
  }

  const blob = await fetchVideoBlobFromNetwork(task);
  if (!blob || !blob.size) throw new Error('视频文件为空');

  const id = videoBlobId(task);
  await Blobs.put(id, blob);
  task.videoBlobId = id;
  task.videoMime = blob.type || 'video/mp4';
  task.videoBytes = blob.size;
  task.videoCachedAt = Date.now();
  await persistTask(task);
  if (!opts.silent) toast(`№${pad3(task.folio)} 已保存到本机`, 'ok');
  return blob;
}

function setVideoSource(video, task) {
  if (!task.videoBlobId) {
    setManagedVideoSrc(video, videoContentUrl(task.taskId));
    return;
  }
  getCachedVideoBlob(task).then(blob => {
    if (!blob) {
      setManagedVideoSrc(video, videoContentUrl(task.taskId));
      return;
    }
    const url = createVideoObjectUrl(blob);
    setManagedVideoSrc(video, url, url);
  }).catch(() => {
    setManagedVideoSrc(video, videoContentUrl(task.taskId));
  });
}

async function downloadVideoTask(task) {
  try {
    const blob = await ensureVideoCached(task, { silent: true });
    const url = createVideoObjectUrl(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = videoDownloadName(task);
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); videoObjectUrls.delete(url); a.remove(); }, 5000);
    toast(`№${pad3(task.folio)} 下载已开始`, 'ok');
  } catch (err) {
    toast('下载失败：' + err.message, 'bad');
  }
}

async function runButtonTask(button, busyText, work) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  try {
    await work();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

// 异步缓存图片外链为 base64（防止上游 CDN 临时链接过期）
async function cacheImageTaskToDataUrl(task) {
  if (!task || task.imageDataUrl || !task.imageUrl) return;
  try {
    const r = await fetch(task.imageUrl);
    if (!r.ok) return;
    const blob = await r.blob();
    const dataUrl = await new Promise((res, rej) => {
      const rd = new FileReader();
      rd.onload = () => res(rd.result);
      rd.onerror = rej;
      rd.readAsDataURL(blob);
    });
    task.imageDataUrl = dataUrl;
    await persistTask(task);
  } catch {}
}

// ---------- toast ----------
let toastTimer;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (kind ? ' is-' + kind : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

// ---------- backend config ----------
let backendCfg = {
  videoBase: 'api/video',
  imageBase: 'api/image',
  videoUpstream: '',
  imageUpstream: '',
  imageConfigured: false,
};

async function loadBackendConfig() {
  try {
    const r = await fetch('api/config');
    if (r.ok) backendCfg = await r.json();
  } catch {}
}

function refreshUpstreamPill() {
  const pill = $('#upstreamPill');
  const text = $('#upstreamText');
  const mode = currentMode;
  const health = healthState[mode];
  const upstream = mode === 'video' ? backendCfg.videoUpstream : backendCfg.imageUpstream;
  const configured = mode === 'video' ? !!upstream : backendCfg.imageConfigured;
  if (!configured) {
    pill.className = 'upstream-pill is-bad';
    text.textContent = mode === 'video' ? '视频上游未配置' : '图像上游未配置';
    return;
  }
  const label = (mode === 'video' ? '视频 · ' : '图像 · ') + (upstream || '').replace(/^https?:\/\//, '');
  if (!health) {
    pill.className = 'upstream-pill';
    text.textContent = label + ' · 检测中…';
    return;
  }
  if (health.ok) {
    const cls = health.latencyMs < 500 ? 'is-ok' : (health.latencyMs < 1500 ? 'is-warn' : 'is-warn');
    pill.className = 'upstream-pill ' + cls;
    text.textContent = `${label} · ${health.latencyMs} ms`;
  } else {
    pill.className = 'upstream-pill is-bad';
    text.textContent = `${label} · 不通`;
  }
}

const healthState = { video: null, image: null };
async function checkHealth(target) {
  try {
    const r = await fetch('api/check?target=' + target);
    healthState[target] = await r.json();
  } catch {
    healthState[target] = { ok: false };
  }
  refreshUpstreamPill();
}
function startHealthLoop() {
  checkHealth('video');
  checkHealth('image');
  setInterval(() => {
    checkHealth(currentMode);
  }, 30000);
}

// ============================================================
// MODE / PANE switching
// ============================================================
let currentMode = 'video';
let currentPane = 'compose';

function setMode(mode) {
  currentMode = mode;
  $$('.mode').forEach(b => b.classList.toggle('is-active', b.dataset.mode === mode));
  $('#videoForm').classList.toggle('is-hidden', mode !== 'video');
  $('#imageForm').classList.toggle('is-hidden', mode !== 'image');
  $('#folioMode').textContent = mode === 'video' ? '视频' : '图像';
  $('#hed').textContent = mode === 'video' ? '起稿一段动态影像' : '起稿一帧静态图像';
  refreshUpstreamPill();
}

function setPane(pane) {
  currentPane = pane;
  $$('.nav-item').forEach(b => b.classList.toggle('is-active', b.dataset.pane === pane));
  $$('.pane').forEach(p => p.classList.toggle('is-active', p.id === 'pane-' + pane));
  if (pane === 'queue') renderQueue();
  if (pane === 'vault') renderVault();
  if (pane === 'chat')  { renderConvList(); renderChat(); }
}

// ============================================================
// VIDEO model matrix
// ============================================================
const VIDEO_MODELS = {
  sora: [
    { id: 'jimeng-v3-fast', label: 'jimeng-v3-fast · 速度优先' },
    { id: 'jimeng-v3-pro',  label: 'jimeng-v3-pro · 质量优先' },
  ],
  veo: [
    { id: 'gemini-veo-3.1-fast-generate-preview-4s', label: 'veo 3.1 fast · 4 秒' },
    { id: 'gemini-veo-3.1-fast-generate-preview-6s', label: 'veo 3.1 fast · 6 秒' },
    { id: 'gemini-veo-3.1-fast-generate-preview-8s', label: 'veo 3.1 fast · 8 秒' },
    { id: 'gemini-veo-3.1-generate-preview-4s',      label: 'veo 3.1 标准 · 4 秒' },
    { id: 'gemini-veo-3.1-generate-preview-6s',      label: 'veo 3.1 标准 · 6 秒' },
    { id: 'gemini-veo-3.1-generate-preview-8s',      label: 'veo 3.1 标准 · 8 秒' },
    { id: 'gemini-veo-3.1-generate-preview-ref-4s',  label: 'veo 3.1 ref · 4 秒' },
    { id: 'gemini-veo-3.1-generate-preview-ref-6s',  label: 'veo 3.1 ref · 6 秒' },
    { id: 'gemini-veo-3.1-generate-preview-ref-8s',  label: 'veo 3.1 ref · 8 秒' },
  ],
};
const VIDEO_SIZES = {
  sora: ['1280x720', '720x1280', '1920x1080', '1080x1920', '1792x1024', '1024x1792'],
  veo:  ['1280x720', '720x1280', '1920x1080', '1080x1920'],
};

function fillSelect(sel, items, current) {
  sel.innerHTML = '';
  for (const it of items) {
    const opt = document.createElement('option');
    opt.value = typeof it === 'string' ? it : it.id;
    opt.textContent = typeof it === 'string' ? it : it.label;
    if (opt.value === current) opt.selected = true;
    sel.appendChild(opt);
  }
}

let vProvider = 'sora';
function setVideoProvider(p) {
  vProvider = p;
  $$('#vProvider .seg-opt').forEach(b => b.classList.toggle('is-active', b.dataset.val === p));
  fillSelect($('#vModel'), VIDEO_MODELS[p]);
  fillSelect($('#vSize'), VIDEO_SIZES[p]);
  // toggles
  $('#vSecondsWrap').hidden = (p !== 'sora');
  $('#vAspectWrap').hidden  = (p !== 'veo');
  $('#vAudioWrap').hidden   = (p !== 'veo');
  $('#vNegativeWrap').hidden= (p !== 'veo');
  updateVideoRefHint();
}

function updateVideoRefHint() {
  const m = $('#vModel').value;
  let max = 4; // sora
  if (vProvider === 'veo') {
    max = m.includes('-ref-') ? 3 : 2;
  }
  $('#vRefHint').textContent = `最多 ${max} 张`;
  vRefMax = max;
}
let vRefMax = 4;

// ============================================================
// IMAGE model matrix
// ============================================================
const IMAGE_PROVIDERS = {
  openai: { models: ['gpt-image-2'] },
  gemini: { models: ['nanobananapro', 'nanobanana2'] },
};
const IMAGE_SIZES_OPENAI = ['1024x1024','1536x1024','1024x1536','2048x2048','1792x1024','1024x1792','3840x2160','1536x2752','2752x1536'];
const ASPECT_BY_MODEL = {
  nanobananapro: ['21:9','16:9','3:2','4:3','5:4','1:1','4:5','3:4','2:3','9:16'],
  nanobanana2:   ['8:1','4:1','21:9','16:9','3:2','4:3','5:4','1:1','4:5','3:4','2:3','9:16','1:4','1:8'],
};

let iProvider = 'openai';
let iEndpoint = 'generations';
let iQuality = 'low';
let iImageSize = '1K';
let iCount = 1;

function setImageProvider(p) {
  iProvider = p;
  $$('#iProvider .seg-opt').forEach(b => b.classList.toggle('is-active', b.dataset.val === p));
  fillSelect($('#iModel'), IMAGE_PROVIDERS[p].models);
  updateImageFields();
}
function updateImageFields() {
  if (iProvider === 'openai') {
    $('#iEndpointWrap').hidden    = false;
    $('#iSizeWrap').hidden        = false;
    $('#iAspectWrap').hidden      = true;
    $('#iImageSizeWrap').hidden   = true;
    $('#iQualityWrap').hidden     = false;
    $('#iCountWrap').hidden       = false;
    fillSelect($('#iSize'), IMAGE_SIZES_OPENAI);
  } else {
    $('#iEndpointWrap').hidden    = true;
    $('#iSizeWrap').hidden        = true;
    $('#iAspectWrap').hidden      = false;
    $('#iImageSizeWrap').hidden   = false;
    $('#iQualityWrap').hidden     = true;
    $('#iCountWrap').hidden       = true;
    const m = $('#iModel').value || IMAGE_PROVIDERS.gemini.models[0];
    fillSelect($('#iAspect'), ASPECT_BY_MODEL[m] || ASPECT_BY_MODEL.nanobananapro);
  }
}

// ============================================================
// reference images
// ============================================================
const refs = { video: [], image: [] };

function refKindForMode(mode) { return mode; }

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// ===== 参考图预处理：格式校验 + 自动压缩 =====
const REF_ALLOWED = ['image/png', 'image/jpeg', 'image/webp'];

function dataUrlBytes(d) {
  if (!d || typeof d !== 'string') return 0;
  const m = /^data:[^;]+;base64,(.+)$/.exec(d);
  if (!m) return d.length;
  return Math.floor(m[1].length * 0.75);
}

function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(b < 1024 * 10 ? 1 : 0) + ' KB';
  return (b / (1024 * 1024)).toFixed(b < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
}

async function compressImageDataUrl(srcDataUrl, maxDim, quality, preferType) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const scale = Math.min(1, maxDim / Math.max(width, height));
      width = Math.round(width * scale);
      height = Math.round(height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      // 透明 PNG 转 JPEG 时铺白底
      if (preferType === 'image/jpeg') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
      }
      ctx.drawImage(img, 0, 0, width, height);
      try {
        resolve(canvas.toDataURL(preferType || 'image/jpeg', quality));
      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error('图片解析失败'));
    img.src = srcDataUrl;
  });
}

async function preprocessRefFile(file) {
  if (!REF_ALLOWED.includes(file.type)) {
    toast(`不支持的格式 ${file.type || '未知'}，仅接受 PNG / JPEG / WebP`, 'bad');
    throw new Error('unsupported_type');
  }
  const raw = await fileToDataUrl(file);
  // 触发压缩条件：体积 > 阈值 或 图片大于 maxDim
  if (!settings.refAutoCompress) {
    return { src: raw, kind: 'data', origSize: file.size, finalSize: file.size, compressed: false };
  }
  // 先检测尺寸
  const dims = await new Promise((res) => {
    const img = new Image();
    img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => res({ w: 0, h: 0 });
    img.src = raw;
  });
  const tooBig = file.size > settings.refMaxBytes;
  const tooLarge = Math.max(dims.w, dims.h) > settings.refMaxDim;
  if (!tooBig && !tooLarge) {
    return { src: raw, kind: 'data', origSize: file.size, finalSize: file.size, compressed: false, dims };
  }
  // 透明图保留 png，否则用 jpeg
  const preferType = file.type === 'image/png' ? 'image/jpeg' : (file.type === 'image/webp' ? 'image/webp' : 'image/jpeg');
  const compressed = await compressImageDataUrl(raw, settings.refMaxDim, settings.refJpegQuality, preferType);
  const finalSize = dataUrlBytes(compressed);
  if (finalSize >= file.size && file.size <= settings.refMaxBytes * 2) {
    // 压缩没省下太多，反而带来质量损失 — 用原图
    return { src: raw, kind: 'data', origSize: file.size, finalSize: file.size, compressed: false, dims };
  }
  return { src: compressed, kind: 'data', origSize: file.size, finalSize, compressed: true, dims };
}

function refMax(mode) {
  if (mode === 'video') return vRefMax;
  return 6;
}

function addRef(mode, ref) {
  const arr = refs[mode];
  if (arr.length >= refMax(mode)) {
    toast(`参考图已达上限 ${refMax(mode)} 张`, 'bad');
    return;
  }
  arr.push(ref);
  renderThumbs(mode);
}
function removeRef(mode, idx) {
  refs[mode].splice(idx, 1);
  renderThumbs(mode);
}
function renderThumbs(mode) {
  const root = mode === 'video' ? $('#vThumbs') : $('#iThumbs');
  root.innerHTML = '';
  refs[mode].forEach((r, idx) => {
    const div = document.createElement('div');
    div.className = 'thumb';
    const img = document.createElement('img');
    img.src = r.src;
    img.alt = '';
    img.onerror = () => { img.replaceWith(document.createTextNode('URL?')); };
    div.appendChild(img);
    const meta = document.createElement('div');
    meta.className = 'thumb-meta';
    const sizeStr = r.size ? fmtBytes(r.size) : (r.kind === 'url' ? 'URL' : 'b64');
    const label = idx === 0 && mode === 'video' ? '首帧' : ('#' + (idx + 1));
    meta.innerHTML = `<span>${label}</span><span>${sizeStr}${r.compressed ? '·c' : ''}</span>`;
    div.appendChild(meta);
    // 工具：vision 反推 + 删除
    const tools = document.createElement('div');
    tools.className = 'thumb-tools';
    const reverse = document.createElement('button');
    reverse.type = 'button';
    reverse.className = 'thumb-tool';
    reverse.textContent = '看图写词';
    reverse.title = '调用 vision LLM 反推提示词';
    reverse.addEventListener('click', (e) => { e.stopPropagation(); reverseImageToPrompt(r); });
    tools.appendChild(reverse);
    const rmInline = document.createElement('button');
    rmInline.type = 'button';
    rmInline.className = 'thumb-tool';
    rmInline.textContent = '×';
    rmInline.addEventListener('click', (e) => { e.stopPropagation(); removeRef(mode, idx); });
    tools.appendChild(rmInline);
    div.appendChild(tools);
    root.appendChild(div);
  });
}

function bindDropzone(zoneEl, fileInput, urlInput, pickBtn, mode) {
  zoneEl.addEventListener('dragover', (e) => { e.preventDefault(); zoneEl.classList.add('is-drag'); });
  zoneEl.addEventListener('dragleave', () => zoneEl.classList.remove('is-drag'));
  zoneEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    zoneEl.classList.remove('is-drag');
    for (const f of e.dataTransfer.files) {
      if (f.type.startsWith('image/')) {
        // 构图页保留原图，不压缩（保真传给生成模型）
        const d = await fileToDataUrl(f);
        addRef(mode, { kind: 'data', src: d, size: f.size });
      }
    }
  });
  pickBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    for (const f of fileInput.files) {
      const d = await fileToDataUrl(f);
      addRef(mode, { kind: 'data', src: d, size: f.size });
    }
    fileInput.value = '';
  });
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = urlInput.value.trim();
      if (!v) return;
      // 支持一次粘多个 URL：按空格 / 逗号 / 换行 / 分号分割
      const urls = v.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
      let added = 0;
      for (const u of urls) {
        if (/^https?:\/\//i.test(u) || u.startsWith('data:')) {
          addRef(mode, { kind: u.startsWith('data:') ? 'data' : 'url', src: u });
          added++;
        }
      }
      if (added === 0) {
        // 兼容：原样作为 url 添加
        addRef(mode, { kind: 'url', src: v });
      } else if (added > 1) {
        toast(`已添加 ${added} 个 URL`, 'ok');
      }
      urlInput.value = '';
    }
  });
}

// ============================================================
// VIDEO submit + poll
// ============================================================
function buildVideoBody() {
  const prompt = $('#vPrompt').value.trim();
  const model = $('#vModel').value;
  const size  = $('#vSize').value;
  const body = { model, prompt, size };
  if (vProvider === 'sora') {
    body.seconds = String(parseInt($('#vSeconds').value || '7', 10));
  }
  if (vProvider === 'veo') {
    const neg = $('#vNegative').value.trim();
    if (neg) body.negative_prompt = neg;
    if ($('#vAudio').checked) body.generate_audio = true;
  }
  return body;
}

async function submitVideo() {
  const body = buildVideoBody();
  if (!body.prompt) { toast('提示词不能为空', 'bad'); return; }
  if (!backendCfg.videoUpstream) { toast('视频上游未配置', 'bad'); return; }
  await submitVideoRaw(body, refs.video.slice(), { provider: vProvider });
}

async function submitVideoRaw(body, refList, opts = {}) {
  const r = refList || [];
  const bodyCopy = { ...body };
  if (r.length === 1) bodyCopy.image = r[0].src;
  else if (r.length > 1) bodyCopy.images = r.map(x => x.src);

  setBusy('video', true);
  $('#vStatus').textContent = '正在提交…';

  try {
    const resp = await apiFetch('video', '/v1/videos', { method: 'POST', body: bodyCopy, kind: 'video' });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${text}`);
    }
    const data = await resp.json();
    const num = await bumpEdition();
    const task = {
      localId: 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      folio: num,
      kind: 'video',
      provider: opts.provider || vProvider,
      taskId: data.id,
      model: bodyCopy.model,
      prompt: bodyCopy.prompt,
      size: bodyCopy.size,
      seconds: bodyCopy.seconds,
      params: bodyCopy,
      groupId: opts.groupId || null,
      retryOf: opts.retryOf || null,
      variantLabel: opts.variantLabel || null,
      status: normalizeTaskStatus(data.status || 'queued'),
      progress: normalizeProgress(data.progress, normalizeTaskStatus(data.status || 'queued')),
      createdAt: Date.now(),
      completedAt: null,
      videoUrl: null,
      error: null,
      refs: r.slice(),
    };
    tasks.unshift(task);
    await persistTask(task);
    $('#vStatus').textContent = `已提交 · ${task.taskId}`;
    toast(`已提交 №${pad3(num)}`, 'ok');
    renderQueue();
    highlightRecent(task.localId);
    if (settings.autoPoll) pollVideo(task);
    return task;
  } catch (err) {
    $('#vStatus').textContent = '';
    toast('提交失败：' + err.message, 'bad');
    throw err;
  } finally {
    setBusy('video', false);
  }
}

const polling = new Set();
async function pollVideo(task) {
  if (polling.has(task.localId)) return;
  polling.add(task.localId);

  const tick = async () => {
    if (!taskExists(task.localId)) {
      polling.delete(task.localId);
      return;
    }
    try {
      const r = await apiFetch('video', `/v1/videos/${task.taskId}`, { method: 'GET', kind: 'video' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      if (!taskExists(task.localId)) {
        polling.delete(task.localId);
        return;
      }
      const nextStatus = normalizeTaskStatus(d.status || task.status);
      task.status = nextStatus;
      task.progress = normalizeProgress(d.progress ?? task.progress, nextStatus);
      if (nextStatus === 'completed') {
        task.videoUrl = d.video_url || d.metadata?.url || d.metadata?.video_url || task.videoUrl || null;
        task.completedAt = Date.now();
        ensureVideoCached(task, { silent: true })
          .then(() => { renderQueue(); renderVault(); renderRecent(); })
          .catch(err => console.warn('video cache failed', err));
      } else if (nextStatus === 'failed') {
        task.error = d.error || 'failed';
        task.completedAt = Date.now();
      }
      saveTaskAsync(task);
      renderQueue();
      if (FINAL_TASK_STATUSES.has(nextStatus)) {
        polling.delete(task.localId);
        if (nextStatus === 'completed') {
          toast(`№${pad3(task.folio)} 已完成`, 'ok');
        } else {
          toast(`№${pad3(task.folio)} 生成失败`, 'bad');
        }
        return;
      }
    } catch (err) {
      // keep trying — but back off
      console.warn('poll error', err);
    }
    setTimeout(tick, 5000);
  };
  tick();
}

// ============================================================
// IMAGE submit (synchronous)
// ============================================================
function buildImageRequest() {
  const prompt = $('#iPrompt').value.trim();
  const model = $('#iModel').value;
  let path, body;
  if (iProvider === 'openai') {
    path = iEndpoint === 'edits' ? '/v1/images/edits' : '/v1/images/generations';
    body = {
      model,
      prompt,
      size: $('#iSize').value,
      quality: iQuality,
      response_format: 'url',
      __endpoint: iEndpoint, // 内部记号，submit 前会移除
    };
  } else {
    path = `/v1beta/models/${model}:generateContent`;
    body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }], // refs 在 submit 时加
      generation_config: {
        response_modalities: ['IMAGE'],
        image_config: {
          aspect_ratio: $('#iAspect').value,
          image_size: iImageSize,
        },
      },
    };
  }
  return { path, body, model, prompt };
}

async function submitImage() {
  const { body, prompt } = buildImageRequest();
  if (!prompt) { toast('提示词不能为空', 'bad'); return; }
  if (!backendCfg.imageConfigured) { toast('图像上游未配置', 'bad'); return; }
  if (iProvider === 'openai' && iEndpoint === 'edits' && !refs.image.length) {
    toast('图生图模式必须传至少 1 张底图', 'bad');
    return;
  }
  const opts = { provider: iProvider, endpoint: iEndpoint };
  if (iProvider === 'openai' && iCount > 1) opts.n = iCount;
  await submitImageRaw(body, refs.image.slice(), opts);
}

async function imageJobFetch(path, body, localIds) {
  const headers = { 'Content-Type': 'application/json' };
  if (settings.imageToken) headers['Authorization'] = `Bearer ${settings.imageToken}`;
  const resp = await fetch('api/image-job', {
    method: 'POST',
    headers,
    body: JSON.stringify({ path, body, localIds }),
  });
  if (resp.status === 404) {
    return apiFetch('image', path, { method: 'POST', body, kind: 'image' });
  }
  return resp;
}

async function applyImageResponseToTasks(provider, tasksList, data) {
  if (provider === 'openai') {
    const items = data?.data || [];
    for (let i = 0; i < tasksList.length; i++) {
      const t = tasksList[i];
      const item = items[i];
      if (item) {
        if (item.url) t.imageUrl = item.url;
        if (item.b64_json) t.imageDataUrl = 'data:image/png;base64,' + item.b64_json;
        t.status = 'completed';
        t.progress = 100;
        t.error = null;
      } else {
        t.status = 'failed';
        t.error = '上游未返回此张';
      }
      t.completedAt = Date.now();
      await persistTask(t);
      if (t.status === 'completed' && t.imageUrl && !t.imageDataUrl) {
        cacheImageTaskToDataUrl(t);
      }
    }
    return;
  }

  const t = tasksList[0];
  const partsR = data?.candidates?.[0]?.content?.parts || [];
  for (const p of partsR) {
    const inline = p.inlineData || p.inline_data;
    if (inline?.data) {
      t.imageDataUrl = `data:${inline.mimeType || 'image/png'};base64,${inline.data}`;
      break;
    }
  }
  t.status = 'completed';
  t.progress = 100;
  t.error = null;
  t.completedAt = Date.now();
  await persistTask(t);
}

async function restoreImageJob(task) {
  if (!task || task.kind !== 'image') return 0;
  if (!(ACTIVE_TASK_STATUSES.has(task.status) || task.status === 'unsaved')) return 0;
  let r;
  const headers = {};
  if (settings.imageToken) headers['Authorization'] = `Bearer ${settings.imageToken}`;
  try {
    r = await fetch(`api/image-job/${encodeURIComponent(task.localId)}`, { cache: 'no-store', headers });
  } catch {
    return 0;
  }
  if (!r.ok) {
    const q = new URLSearchParams({
      createdAt: String(task.createdAt || ''),
      model: task.model || '',
      prompt: task.prompt || '',
    });
    try {
      r = await fetch(`api/image-job-recent?${q}`, { cache: 'no-store', headers });
    } catch {
      return 0;
    }
  }
  if (!r.ok) return 0;
  let record;
  try { record = await r.json(); } catch { return 0; }
  if (!record?.ok || !record.body) return 0;
  let data;
  try { data = JSON.parse(record.body); } catch { return 0; }
  const groupTasks = task.groupId
    ? tasks.filter(t => t.groupId === task.groupId && t.kind === 'image').sort((a, b) => a.folio - b.folio)
    : [task];
  await applyImageResponseToTasks(task.provider || 'openai', groupTasks, data);
  return groupTasks.length;
}

async function restoreImageJobs() {
  let recovered = 0;
  const seenGroups = new Set();
  for (const t of tasks) {
    if (t.kind !== 'image') continue;
    if (!(ACTIVE_TASK_STATUSES.has(t.status) || t.status === 'unsaved')) continue;
    const key = t.groupId || t.localId;
    if (seenGroups.has(key)) continue;
    seenGroups.add(key);
    recovered += await restoreImageJob(t);
  }
  return recovered;
}

async function submitImageRaw(rawBody, refList, opts = {}) {
  const provider = opts.provider || iProvider;
  const endpoint = opts.endpoint || iEndpoint;
  const model = rawBody.model || (rawBody.contents ? null : null);
  const n = Math.max(1, Math.min(6, parseInt(opts.n || rawBody.n || 1, 10) || 1));
  let path, body;
  if (provider === 'openai') {
    path = endpoint === 'edits' ? '/v1/images/edits' : '/v1/images/generations';
    body = { ...rawBody };
    delete body.__endpoint;
    if (refList.length) body.image = refList.map(r => r.src);
    if (n > 1) body.n = n;
    else delete body.n;
  } else {
    // gemini 不支持 n>1
    const modelName = rawBody.__model || model || ($('#iModel').value);
    path = `/v1beta/models/${modelName}:generateContent`;
    body = JSON.parse(JSON.stringify(rawBody));
    const parts = body.contents?.[0]?.parts || [];
    const textPart = parts.find(p => p.text);
    body.contents[0].parts = textPart ? [textPart] : parts.slice(0, 1);
    for (const r of refList) {
      let dataB64 = r.src;
      let mime = 'image/png';
      if (r.kind === 'data') {
        const m = /^data:([^;]+);base64,(.+)$/.exec(r.src);
        if (m) { mime = m[1]; dataB64 = m[2]; }
      } else {
        try {
          const fetched = await fetch(r.src);
          const blob = await fetched.blob();
          mime = blob.type || 'image/png';
          dataB64 = await blobToBase64(blob);
        } catch {
          toast('参考图下载失败', 'bad');
          throw new Error('参考图下载失败');
        }
      }
      body.contents[0].parts.push({ inlineData: { mimeType: mime, data: dataB64 } });
    }
    body.__model = modelName;
  }

  const promptText = provider === 'openai' ? body.prompt : (body.contents[0].parts.find(p => p.text)?.text || '');
  const modelLabel = provider === 'openai' ? body.model : (body.__model || model);
  const sizeLabel = provider === 'openai'
    ? body.size
    : `${body.generation_config.image_config.aspect_ratio} · ${body.generation_config.image_config.image_size}`;

  // 创建 N 个占位 task（n>1 时共享 groupId）
  const groupId = opts.groupId || (n > 1 ? 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5) : null);
  const tasksList = [];
  for (let i = 0; i < n; i++) {
    const num = await bumpEdition();
    const task = {
      localId: 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + (n > 1 ? '_' + i : ''),
      folio: num,
      kind: 'image',
      provider,
      taskId: null,
      model: modelLabel,
      prompt: promptText,
      size: sizeLabel,
      params: provider === 'openai' ? { ...body, __endpoint: endpoint } : body,
      groupId,
      retryOf: opts.retryOf || null,
      variantLabel: opts.variantLabel || (n > 1 ? `${i + 1}/${n}` : null),
      status: 'in_progress',
      progress: 0,
      createdAt: Date.now(),
      completedAt: null,
      imageUrl: null,
      imageDataUrl: null,
      error: null,
      refs: refList.slice(),
    };
    tasks.unshift(task);
    await persistTask(task);
    tasksList.push(task);
  }
  renderQueue();
  if (tasksList.length) highlightRecent(tasksList[0].localId);

  setBusy('image', true);
  $('#iStatus').textContent = n > 1 ? `正在生成 ${n} 张…` : '正在生成…';
  try {
    const sendBody = { ...body };
    delete sendBody.__endpoint;
    delete sendBody.__model;
    const maxRetries = 2;
    let r, text;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          $('#iStatus').textContent = `第 ${attempt + 1} 次尝试…`;
          toast(`图像生成重试 (${attempt + 1}/${maxRetries + 1})`, 'warn');
        }
        r = await imageJobFetch(path, sendBody, tasksList.map(t => t.localId));
        text = await r.text();
        if (r.ok) break;
        const isRetryable = r.status >= 500 || r.status === 408 || r.status === 524;
        if (!isRetryable || attempt === maxRetries) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
      } catch (fetchErr) {
        if (attempt === maxRetries) throw fetchErr;
        const isNetworkErr = !fetchErr.message.startsWith('HTTP ');
        if (!isNetworkErr && fetchErr.message.startsWith('HTTP 4') && !fetchErr.message.startsWith('HTTP 408') && !fetchErr.message.startsWith('HTTP 429')) throw fetchErr;
      }
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
    const data = JSON.parse(text);
    await applyImageResponseToTasks(provider, tasksList, data);
    renderQueue();
    renderVault();
    highlightRecent(tasksList[0].localId);
    $('#iStatus').textContent = '已完成';
    const folios = tasksList.map(t => '№' + pad3(t.folio)).join(' · ');
    toast(`${folios} 已完成`, 'ok');
  } catch (err) {
    for (const t of tasksList) {
      t.status = 'failed';
      t.error = err.message;
      t.completedAt = Date.now();
      await persistTask(t);
    }
    renderQueue();
    $('#iStatus').textContent = '';
    toast('生成失败：' + err.message, 'bad');
  } finally {
    setBusy('image', false);
  }
  return tasksList[0];
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = r.result;
      const m = /^data:[^;]+;base64,(.+)$/.exec(s);
      resolve(m ? m[1] : s);
    };
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// ============================================================
// API helper
// ============================================================
async function apiFetch(target, path, opts) {
  const base = target === 'video' ? backendCfg.videoBase : backendCfg.imageBase;
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const token = target === 'video' ? settings.videoToken : settings.imageToken;
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const init = { method: opts.method || 'GET', headers };
  if (opts.body !== undefined) init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  return fetch(base + path, init);
}

function setBusy(kind, busy) {
  const btn = kind === 'video' ? $('#vSubmit') : $('#iSubmit');
  btn.disabled = busy;
  btn.classList.toggle('is-busy', busy);
}

// ============================================================
// LLM-powered prompt optimize / translate
// ============================================================
const PROMPTS = {
  optimizeVideo: '你是一位资深电影摄影指导兼提示词工程师。请把用户输入改写为一段具体、画面感强烈的视频生成提示词。要包含：主体与动作、镜头（角度/焦距/运动）、布光、色彩与调色、环境、情绪。如果用户写的是中文，请输出地道流畅的英文（视频模型对英文响应更稳定）；如果用户写的是英文，请直接打磨英文版本。直接输出改写后的提示词，不要任何前言、解释或引号。',
  optimizeImage: '你是一位资深艺术指导兼提示词工程师。请把用户输入改写为一段具体、画面感强烈的图像生成提示词。要包含：主体、构图、风格、材质、布光、配色、情绪。如果用户写的是中文，请输出地道流畅的英文（图像模型对英文响应更稳定）；如果用户写的是英文，请直接打磨英文版本。直接输出改写后的提示词，不要任何前言、解释或引号。',
  translate:     '请把以下文本翻译为流畅地道的英文，作为生成式模型的提示词使用。保留所有具体名词与原意，不要添加内容，不要解释。直接输出译文。',
};

async function callLlm(systemPrompt, userText) {
  const cfg = getActiveLlmConfig();
  if (!settings.llmEnabled) throw new Error('提示词增强未启用，请在「密钥」中开启');
  if (!cfg.base)    throw new Error('LLM 接口地址未配置');
  if (!cfg.key)     throw new Error('LLM API 密钥未配置');
  if (!cfg.model)   throw new Error('LLM 模型未配置');

  const persona = cfg.persona && cfg.persona.trim() ? cfg.persona.trim() : systemPrompt;
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: persona },
      { role: 'user', content: userText },
    ],
    temperature: 0.7,
  };
  const msg = await callLlmChat(body);
  const out = msg?.content;
  if (!out) throw new Error('LLM 返回为空');
  return out.trim().replace(/^["'`]+|["'`]+$/g, '');
}

let llmContext = null; // { targetId, kind, mode, original }

async function runLlm(action) {
  const ta = $('#' + llmContext.targetId);
  const original = ta.value.trim();
  if (!original) { toast('请先输入提示词', 'bad'); return; }
  $('#llmAux').textContent = '正在思考…';
  $('#llmOut').value = '';
  $('#llmOrig').textContent = original;
  llmContext.original = original;
  llmContext.action = action;

  const sys = action === 'translate'
    ? PROMPTS.translate
    : (llmContext.kind === 'video' ? PROMPTS.optimizeVideo : PROMPTS.optimizeImage);
  try {
    const out = await callLlm(sys, original);
    $('#llmOut').value = out;
    $('#llmAux').textContent = `模型 · ${getActiveLlmConfig().model}`;
  } catch (err) {
    $('#llmAux').textContent = '';
    toast('调用失败：' + err.message, 'bad');
    closeLlmPop();
  }
}

function openLlmPop(targetId, kind, action) {
  if (!llmReady()) {
    toast('请先在「密钥」中配置并启用提示词增强', 'bad');
    openDrawer();
    return;
  }
  llmContext = { targetId, kind, action };
  $('#llmPop').hidden = false;
  runLlm(action);
}
function closeLlmPop() {
  $('#llmPop').hidden = true;
  llmContext = null;
}

// ============================================================
// QUEUE rendering
// ============================================================
let queueFilter = 'all';

const STATUS_TEXT = {
  queued: '排队中',
  in_progress: '生成中',
  completed: '已完成',
  failed: '失败',
  unsaved: '已生成未保存',
};
const KIND_TEXT = { video: '视频', image: '图像' };
const FINAL_TASK_STATUSES = new Set(['completed', 'failed', 'unsaved']);
const ACTIVE_TASK_STATUSES = new Set(['queued', 'in_progress']);
const deletedTaskIds = new Set();
const IMAGE_SYNC_STALE_MS = 5 * 60 * 1000;
const TASK_REFRESH_MS = 10 * 1000;

function normalizeTaskStatus(status) {
  const s = String(status || '').toLowerCase();
  if (['queued', 'queue', 'pending', 'created'].includes(s)) return 'queued';
  if (['in_progress', 'processing', 'running', 'submitted', 'starting'].includes(s)) return 'in_progress';
  if (['completed', 'complete', 'succeeded', 'success', 'done'].includes(s)) return 'completed';
  if (['failed', 'failure', 'error', 'cancelled', 'canceled', 'timeout', 'expired'].includes(s)) return 'failed';
  if (['unknown', 'unsaved', 'lost'].includes(s)) return 'unsaved';
  return status || 'queued';
}

function normalizeProgress(progress, status) {
  if (status === 'completed') return 100;
  if (progress === undefined || progress === null || progress === '') return 0;
  if (typeof progress === 'string') {
    const n = parseFloat(progress.replace('%', ''));
    return Number.isFinite(n) ? n : 0;
  }
  return Number.isFinite(Number(progress)) ? Number(progress) : 0;
}

async function normalizeLoadedTasks() {
  for (const t of tasks) {
    let changed = false;
    const status = normalizeTaskStatus(t.status);
    if (status !== t.status) {
      t.status = status;
      t.progress = normalizeProgress(t.progress, status);
      changed = true;
    }
    if (changed) await persistTask(t);
  }
}

function markStaleImageTasks() {
  const now = Date.now();
  let changed = false;
  for (const t of tasks) {
    if (t.kind !== 'image') continue;
    if (!ACTIVE_TASK_STATUSES.has(t.status)) continue;
    if (now - (t.createdAt || now) < IMAGE_SYNC_STALE_MS) continue;
    t.status = 'unsaved';
    t.progress = 0;
    t.error = '上游已生成或已扣费，但结果没有保存到浏览器；服务端短期缓存中也未找到。';
    t.completedAt = t.completedAt || now;
    saveTaskAsync(t);
    changed = true;
  }
  return changed;
}

function fmtDuration(ms) {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' 秒';
  return Math.floor(s / 60) + ' 分 ' + (s % 60).toString().padStart(2, '0') + ' 秒';
}
function fmtTime(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function taskExists(localId) {
  return tasks.some(t => t.localId === localId) && !deletedTaskIds.has(localId);
}

async function deleteTaskRecord(task, opts = {}) {
  if (!task?.localId) return;
  deletedTaskIds.add(task.localId);
  polling.delete(task.localId);
  if (task.videoBlobId) await Blobs.delete(task.videoBlobId).catch(() => {});
  await Tasks.delete(task.localId);
  tasks = tasks.filter(t => t.localId !== task.localId);
  if (!opts.silent) toast(`已删除 №${pad3(task.folio)}`, 'ok');
}

async function confirmDeleteTask(task) {
  const active = ACTIVE_TASK_STATUSES.has(task.status);
  const msg = active
    ? `删除 №${pad3(task.folio)}？记录会从本机移除；上游任务可能仍会继续运行并计费。`
    : `删除 №${pad3(task.folio)}？`;
  if (!(await uiConfirm(msg, { okText: '删除', danger: true }))) return;
  await deleteTaskRecord(task);
  renderQueue();
  renderVault();
  renderRecent();
}

function addQueueDeleteButton(parent, task, className = 'q-delete') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = '删除';
  btn.title = '删除这条任务记录';
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await confirmDeleteTask(task);
  });
  parent.appendChild(btn);
  return btn;
}

function renderQueue() {
  const filtered = tasks.filter(t => {
    if (queueFilter === 'all') return true;
    if (queueFilter === 'video' || queueFilter === 'image') return t.kind === queueFilter;
    if (queueFilter === 'active') return ACTIVE_TASK_STATUSES.has(t.status);
    if (queueFilter === 'completed') return t.status === 'completed';
    if (queueFilter === 'failed') return t.status === 'failed';
    return true;
  });

  // group 计数 — 用于在行/卡片上显示 "× N"
  const groupCounts = {};
  for (const t of tasks) {
    if (t.groupId) groupCounts[t.groupId] = (groupCounts[t.groupId] || 0) + 1;
  }

  const list = $('#queueList');
  const grid = $('#queueGrid');
  const view = settings.queueView || 'list';
  list.hidden = view !== 'list';
  grid.hidden = view !== 'grid';

  if (view === 'list') {
    list.innerHTML = '';
    if (!filtered.length) {
      list.innerHTML = '<div class="queue-empty">还没有任务，去「构图」提交一个吧。</div>';
    } else {
      for (const t of filtered) {
        const li = document.createElement('li');
        const row = document.createElement('div');
        row.className = 'queue-row';
        const dur = t.completedAt ? fmtDuration(t.completedAt - t.createdAt) : (t.status === 'in_progress' ? `${t.progress || 0}%` : fmtTime(t.createdAt));
        const groupTag = t.groupId ? `<span class="q-group">组 ×${groupCounts[t.groupId]}</span>` : '';
        const variantTag = t.variantLabel ? ` · <span class="muted">${escapeHtml(t.variantLabel)}</span>` : '';
        row.innerHTML = `
          <span class="q-folio">№${pad3(t.folio)}</span>
          <span class="q-kind">${KIND_TEXT[t.kind] || t.kind}${groupTag}</span>
          <span class="q-prompt">${escapeHtml(t.prompt)}${variantTag}</span>
          <span class="q-model">${escapeHtml(t.model)}</span>
          <span class="q-status q-${t.status}"><span class="dot"></span>${STATUS_TEXT[t.status] || t.status}</span>
          <span class="q-open">${dur}</span>
        `;
        addQueueDeleteButton(row, t);
        row.addEventListener('click', () => openModal(t));
        li.appendChild(row);
        list.appendChild(li);
      }
    }
  } else {
    grid.innerHTML = '';
    if (!filtered.length) {
      grid.innerHTML = '<div class="vault-empty">还没有任务，去「构图」提交一个吧。</div>';
    } else {
      for (const t of filtered) {
        const card = document.createElement('div');
        card.className = 'qg-card';
        const media = document.createElement('div');
        media.className = 'qg-media';
        if (t.kind === 'image' && (t.imageDataUrl || t.imageUrl)) {
          const img = document.createElement('img');
          img.src = t.imageDataUrl || t.imageUrl;
          media.appendChild(img);
        } else if (t.kind === 'video' && t.status === 'completed' && t.taskId) {
          const v = document.createElement('video');
          setVideoSource(v, t);
          v.muted = true;
          v.playsInline = true;
          v.preload = 'metadata';
          v.addEventListener('mouseenter', () => v.play().catch(() => {}));
          v.addEventListener('mouseleave', () => { v.pause(); v.currentTime = 0; });
          media.appendChild(v);
        } else {
          const pend = document.createElement('div');
          pend.className = 'qg-pending';
          pend.textContent = STATUS_TEXT[t.status] || t.status;
          media.appendChild(pend);
        }
        const badge = document.createElement('span');
        badge.className = 'qg-badge' + (t.status === 'in_progress' || t.status === 'queued' ? ' is-active' : (t.status === 'failed' ? ' is-failed' : ''));
        badge.textContent = (KIND_TEXT[t.kind] || t.kind) + ' · ' + (STATUS_TEXT[t.status] || t.status);
        media.appendChild(badge);
        addQueueDeleteButton(media, t, 'q-card-delete');
        const folio = document.createElement('span');
        folio.className = 'qg-folio';
        folio.textContent = `№${pad3(t.folio)}${t.groupId ? ' · ×' + groupCounts[t.groupId] : ''}`;
        media.appendChild(folio);
        card.appendChild(media);
        const cap = document.createElement('div');
        cap.className = 'qg-cap';
        cap.innerHTML = `
          <div class="qg-prompt">${escapeHtml(t.prompt)}</div>
          <div class="qg-meta">${escapeHtml(t.model)}${t.variantLabel ? ' · ' + escapeHtml(t.variantLabel) : ''}</div>
        `;
        card.appendChild(cap);
        card.addEventListener('click', () => openModal(t));
        grid.appendChild(card);
      }
    }
  }

  $('#navQueueCount').textContent = tasks.length;
  $('#navVaultCount').textContent = tasks.filter(t => t.status === 'completed').length;
  renderRecent();
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function resumeActiveVideoPolling() {
  if (!settings.autoPoll) return;
  for (const t of tasks) {
    if (t.kind === 'video' && t.taskId && ACTIVE_TASK_STATUSES.has(t.status)) {
      pollVideo(t);
    }
  }
}

async function refreshTaskState(opts = {}) {
  const manual = !!opts.manual;
  const btn = $('#queueRefresh');
  if (manual && btn) {
    btn.disabled = true;
    btn.textContent = '同步中…';
  }
  try {
    await reloadTasks({ recover: true });
    resumeActiveVideoPolling();
    renderQueue();
    renderVault();
    renderRecent();
    if (manual) toast('任务状态已同步', 'ok');
  } catch (e) {
    if (manual) toast('同步失败：' + e.message, 'bad');
  } finally {
    if (manual && btn) {
      btn.disabled = false;
      btn.textContent = '刷新状态';
    }
  }
}

// ============================================================
// 页面内对话框（替换浏览器原生 confirm / prompt）
// ============================================================
function uiDialog({ title = '提示', body = '', input = null, okText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    const dlg = $('#dialog');
    const mask = $('#dialogMask');
    if (!dlg || !mask) { resolve(input != null ? null : false); return; }
    $('#dialogTitle').textContent = title;
    let bodyHtml = `<div class="dialog-msg">${escapeHtml(body).replace(/\n/g, '<br>')}</div>`;
    if (input != null) {
      bodyHtml += `<input class="inp dialog-input" id="dlgInput" type="text" value="${escapeHtml(input.value || '')}" placeholder="${escapeHtml(input.placeholder || '')}">`;
    }
    $('#dialogBody').innerHTML = bodyHtml;
    $('#dialogActions').innerHTML = `
      <button class="btn-ghost" id="dlgCancel">${escapeHtml(cancelText)}</button>
      <button class="btn-primary${danger ? ' is-stop' : ''}" id="dlgOk">${escapeHtml(okText)}</button>
    `;
    dlg.hidden = false;
    mask.hidden = false;
    const inp = $('#dlgInput');
    if (inp) {
      setTimeout(() => { inp.focus(); inp.select(); }, 30);
    } else {
      setTimeout(() => $('#dlgOk').focus(), 30);
    }
    const close = (val) => {
      dlg.hidden = true;
      mask.hidden = true;
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const ok = () => close(input != null ? (inp?.value ?? '') : true);
    const cancel = () => close(input != null ? null : false);
    $('#dlgOk').onclick = ok;
    $('#dlgCancel').onclick = cancel;
    mask.onclick = cancel;
    function onKey(e) {
      if (e.key === 'Enter' && (e.target.tagName !== 'TEXTAREA')) { e.preventDefault(); ok(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    }
    document.addEventListener('keydown', onKey);
  });
}

async function uiConfirm(body, opts = {}) {
  return uiDialog({ title: opts.title || '确认', body, okText: opts.okText || '确定', cancelText: opts.cancelText || '取消', danger: !!opts.danger });
}
async function uiPrompt(body, defaultValue = '', opts = {}) {
  return uiDialog({ title: opts.title || '输入', body, input: { value: defaultValue, placeholder: opts.placeholder || '' }, okText: opts.okText || '确定', cancelText: opts.cancelText || '取消' });
}

// ============================================================
// Markdown 渲染（用 marked CDN，含 XSS 清洗）
// ============================================================
function ensureMarked() {
  if (typeof window.marked === 'undefined') return null;
  if (!window.__markedConfigured) {
    try {
      window.marked.setOptions({
        breaks: true,       // 单换行也变 <br>
        gfm: true,          // GitHub Flavored
        headerIds: false,
        mangle: false,
        smartypants: false,
      });
    } catch {}
    window.__markedConfigured = true;
  }
  return window.marked;
}

// 危险标签清洗（保守白名单）
const MD_ALLOWED_TAGS = new Set([
  'P','BR','HR','STRONG','EM','U','S','DEL','CODE','PRE','BLOCKQUOTE',
  'UL','OL','LI','A','H1','H2','H3','H4','H5','H6','SPAN','DIV','TABLE',
  'THEAD','TBODY','TR','TH','TD','IMG',
]);
const MD_ALLOWED_ATTRS = {
  '*': new Set(['class']),
  'A': new Set(['class','href','title','target','rel']),
  'IMG': new Set(['src','alt','title']),
  'CODE': new Set(['class']),
  'PRE': new Set(['class']),
};

function sanitizeNode(node) {
  // 倒序遍历子节点（边删除边遍历）
  const children = Array.from(node.childNodes);
  for (const child of children) {
    if (child.nodeType === 1) { // element
      const tag = child.tagName;
      if (!MD_ALLOWED_TAGS.has(tag)) {
        // 不允许的标签，替换为文本内容
        const txt = document.createTextNode(child.textContent || '');
        child.replaceWith(txt);
        continue;
      }
      // 过滤属性
      const allowedForTag = MD_ALLOWED_ATTRS[tag] || MD_ALLOWED_ATTRS['*'];
      const allowed = new Set([...(MD_ALLOWED_ATTRS['*']), ...allowedForTag]);
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') || !allowed.has(attr.name)) {
          child.removeAttribute(attr.name);
          continue;
        }
        // href / src 防止 javascript: 协议
        if (name === 'href' || name === 'src') {
          const val = attr.value.trim().toLowerCase();
          if (val.startsWith('javascript:') || val.startsWith('data:text/html')) {
            child.removeAttribute(attr.name);
          }
        }
      }
      // 强制外链
      if (tag === 'A') {
        child.setAttribute('target', '_blank');
        child.setAttribute('rel', 'noreferrer noopener');
      }
      sanitizeNode(child);
    } else if (child.nodeType === 8) {
      // comment node — 删
      child.remove();
    }
  }
}

function renderMarkdown(text) {
  const m = ensureMarked();
  if (!m) return escapeHtml(text || '').replace(/\n/g, '<br>');
  let html;
  try { html = m.parse(text || ''); } catch { return escapeHtml(text || '').replace(/\n/g, '<br>'); }
  // 用临时容器清洗
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  sanitizeNode(tmp);
  return tmp.innerHTML;
}

// ============================================================
// COMPOSE 底部「最近生成」
// ============================================================
let recentHighlightId = null;

function renderRecent() {
  const bar = $('#recentBar');
  const grid = $('#recentGrid');
  if (!bar || !grid) return;

  const isWide = window.innerWidth >= 1200;
  const recent = tasks.slice(0, isWide ? 12 : 6);
  if (!recent.length && !isWide) { bar.hidden = true; grid.innerHTML = ''; return; }
  bar.hidden = false;
  grid.innerHTML = '';

  if (!recent.length) {
    const empty = document.createElement('div');
    empty.className = 'recent-empty';
    empty.innerHTML = '尚未生成任何作品。<br>点左侧「生成」按钮，结果会出现在这里。';
    grid.appendChild(empty);
    return;
  }

  for (const t of recent) {
    const card = document.createElement('div');
    card.className = 'recent-card' + (t.localId === recentHighlightId ? ' is-active' : '');

    const media = document.createElement('div');
    media.className = 'recent-media';

    if (t.status === 'completed' && t.kind === 'image' && (t.imageDataUrl || t.imageUrl)) {
      const img = document.createElement('img');
      img.src = t.imageDataUrl || t.imageUrl;
      img.alt = '';
      media.appendChild(img);
    } else if (t.status === 'completed' && t.kind === 'video' && t.taskId) {
      const v = document.createElement('video');
      setVideoSource(v, t);
      v.muted = true;
      v.playsInline = true;
      v.preload = 'metadata';
      v.addEventListener('mouseenter', () => v.play().catch(() => {}));
      v.addEventListener('mouseleave', () => { v.pause(); v.currentTime = 0; });
      media.appendChild(v);
    } else if (t.status === 'failed') {
      const p = document.createElement('div');
      p.className = 'recent-pending is-failed';
      p.innerHTML = `<span class="dot"></span><span>生成失败</span>`;
      media.appendChild(p);
    } else {
      const p = document.createElement('div');
      p.className = 'recent-pending';
      const stxt = STATUS_TEXT[t.status] || t.status;
      const prog = t.progress ? ` · ${t.progress}%` : '';
      p.innerHTML = `<span class="dot"></span><span>${stxt}${prog}</span>`;
      media.appendChild(p);
    }
    card.appendChild(media);

    const cap = document.createElement('div');
    cap.className = 'recent-cap';
    cap.innerHTML = `
      <div class="recent-folio">№${pad3(t.folio)} · ${KIND_TEXT[t.kind] || t.kind}${t.variantLabel ? ' · ' + escapeHtml(t.variantLabel) : ''}</div>
      <div class="recent-prompt">${escapeHtml(t.prompt)}</div>
    `;
    card.appendChild(cap);
    card.addEventListener('click', () => openModal(t));
    grid.appendChild(card);
  }
}

function highlightRecent(localId) {
  recentHighlightId = localId;
  renderRecent();
  // 滚动到 recent 区
  const bar = $('#recentBar');
  if (bar && !bar.hidden) {
    setTimeout(() => bar.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
  }
}

// ============================================================
// VAULT — 多选 + 批量下载
// ============================================================
let vaultSelectMode = false;
let vaultSelected = new Set();

function setVaultSelectMode(on) {
  vaultSelectMode = on;
  if (!on) vaultSelected.clear();
  $('#vaultSelectMode').textContent = on ? '退出多选' : '进入多选';
  $('#vaultActions').hidden = !on || vaultSelected.size === 0;
  $('#vaultSelectInfo').textContent = on ? '点击卡片选中，可多选' : '';
  renderVault();
}

function updateVaultSelection() {
  $('#vaultSelCount').textContent = vaultSelected.size;
  $('#vaultActions').hidden = !vaultSelectMode || vaultSelected.size === 0;
}

function renderVault() {
  const grid = $('#vaultGrid');
  grid.innerHTML = '';
  const done = tasks.filter(t => t.status === 'completed');
  if (!done.length) {
    grid.innerHTML = '<div class="vault-empty">档案是空的。已完成的视频与图像会出现在这里。</div>';
    return;
  }
  for (const t of done) {
    const card = document.createElement('div');
    card.className = 'vault-card' + (vaultSelectMode ? ' is-selectable' : '') + (vaultSelected.has(t.localId) ? ' is-selected' : '');
    const media = document.createElement('div');
    media.className = 'vault-media';
    if (vaultSelectMode) {
      const chk = document.createElement('span');
      chk.className = 'vault-check';
      media.appendChild(chk);
    }
    if (t.kind === 'video' && t.taskId) {
      const v = document.createElement('video');
      setVideoSource(v, t);
      v.muted = true;
      v.playsInline = true;
      v.preload = 'metadata';
      v.addEventListener('mouseenter', () => v.play().catch(() => {}));
      v.addEventListener('mouseleave', () => { v.pause(); v.currentTime = 0; });
      media.appendChild(v);
    } else if (t.imageDataUrl || t.imageUrl) {
      const img = document.createElement('img');
      img.src = t.imageDataUrl || t.imageUrl;
      media.appendChild(img);
    }
    card.appendChild(media);
    const cap = document.createElement('div');
    cap.className = 'vault-cap';
    cap.innerHTML = `
      <div class="vault-folio">№${pad3(t.folio)} · ${KIND_TEXT[t.kind] || t.kind} · ${escapeHtml(t.model)}</div>
      <div class="vault-prompt">${escapeHtml(t.prompt)}</div>
    `;
    card.appendChild(cap);
    card.addEventListener('click', () => {
      if (vaultSelectMode) {
        if (vaultSelected.has(t.localId)) vaultSelected.delete(t.localId);
        else vaultSelected.add(t.localId);
        renderVault();
        updateVaultSelection();
      } else {
        openModal(t);
      }
    });
    grid.appendChild(card);
  }
  updateVaultSelection();
}

async function downloadSelectedAsZip() {
  if (typeof window.JSZip === 'undefined') {
    toast('JSZip 未加载，请刷新页面', 'bad');
    return;
  }
  const ids = Array.from(vaultSelected);
  const selected = tasks.filter(t => ids.includes(t.localId));
  if (!selected.length) { toast('未选中任何项', 'bad'); return; }
  toast(`正在打包 ${selected.length} 项…`, 'ok');
  const btn = $('#vaultDownload');
  btn.disabled = true;
  btn.textContent = '正在打包…';
  const zip = new window.JSZip();
  let okCount = 0, failCount = 0;
  for (const t of selected) {
    const base = `№${pad3(t.folio)}-${(t.model || '').replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    try {
      if (t.kind === 'video' && t.taskId) {
        const blob = await ensureVideoCached(t, { silent: true });
        zip.file(`${base}.mp4`, blob);
        okCount++;
      } else if (t.kind === 'image' && (t.imageDataUrl || t.imageUrl)) {
        const src = t.imageDataUrl || t.imageUrl;
        if (src.startsWith('data:')) {
          const m = /^data:([^;]+);base64,(.+)$/.exec(src);
          if (m) {
            zip.file(`${base}.${m[1].split('/')[1] || 'png'}`, m[2], { base64: true });
            okCount++;
          }
        } else {
          const r = await fetch(src);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const blob = await r.blob();
          const ext = (blob.type || 'image/png').split('/')[1] || 'png';
          zip.file(`${base}.${ext}`, blob);
          okCount++;
        }
      }
      // 也把元数据放进去
      zip.file(`${base}.json`, JSON.stringify({
        folio: t.folio,
        kind: t.kind,
        model: t.model,
        prompt: t.prompt,
        size: t.size,
        seconds: t.seconds,
        createdAt: new Date(t.createdAt).toISOString(),
        params: t.params,
      }, null, 2));
    } catch (err) {
      failCount++;
      console.warn('failed to add', t.localId, err);
    }
  }
  try {
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `atelier-${new Date().toISOString().slice(0, 10)}-${okCount}items.zip`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
    toast(`已打包 ${okCount} 项${failCount ? `（${failCount} 项失败）` : ''}`, 'ok');
  } catch (err) {
    toast('打包失败：' + err.message, 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = '打包下载 ZIP';
  }
}

// ============================================================
// MODAL detail
// ============================================================
function openModal(t) {
  $('#mdFolio').textContent = `№ ${pad3(t.folio)}`;
  $('#mdKind').textContent = KIND_TEXT[t.kind] || t.kind;
  const body = $('#modalBody');
  body.innerHTML = '';

  // media
  const media = document.createElement('div');
  media.className = 'md-media';
  if (t.kind === 'video' && t.status === 'completed' && t.taskId) {
    const v = document.createElement('video');
    setVideoSource(v, t);
    v.controls = true;
    v.autoplay = false;
    media.appendChild(v);
  } else if (t.kind === 'image' && (t.imageDataUrl || t.imageUrl)) {
    const img = document.createElement('img');
    img.src = t.imageDataUrl || t.imageUrl;
    media.appendChild(img);
  } else {
    const empty = document.createElement('div');
    empty.style.color = 'var(--ink-faint)';
    empty.style.fontFamily = 'var(--ff-serif)';
    empty.style.padding = '40px';
    empty.textContent = t.status === 'failed' ? '— 生成失败 —' : '— 生成中 —';
    media.appendChild(empty);
  }
  body.appendChild(media);

  // side
  const side = document.createElement('div');
  side.className = 'md-side';
  side.innerHTML = `
    <div class="md-section">
      <div class="md-key">状态</div>
      <div class="md-val">${STATUS_TEXT[t.status] || t.status}${t.progress ? ` · ${t.progress}%` : ''}${t.error ? ` · ${escapeHtml(t.error)}` : ''}</div>
    </div>
    <div class="md-section">
      <div class="md-key">提示词</div>
      <div class="md-prompt">${escapeHtml(t.prompt)}</div>
    </div>
    <div class="md-section">
      <div class="md-key">模型</div>
      <div class="md-val mono">${escapeHtml(t.model)}</div>
    </div>
    <div class="md-section">
      <div class="md-key">规格</div>
      <div class="md-val mono">${escapeHtml(t.size || '')}${t.seconds ? ' · ' + t.seconds + ' 秒' : ''}</div>
    </div>
    <div class="md-section">
      <div class="md-key">时间</div>
      <div class="md-val mono">提交 ${new Date(t.createdAt).toLocaleString('zh-CN')}${t.completedAt ? '<br>完成 ' + new Date(t.completedAt).toLocaleString('zh-CN') : ''}</div>
    </div>
    ${t.kind === 'video' && t.status === 'completed' ? `<div class="md-section"><div class="md-key">视频文件</div><div class="md-val">${videoCacheLabel(t)}</div></div>` : ''}
    ${t.taskId ? `<div class="md-section"><div class="md-key">上游任务 ID</div><div class="md-val mono">${t.taskId}</div></div>` : ''}
  `;

  const actions = document.createElement('div');
  actions.className = 'md-actions';

  if (t.kind === 'video' && t.status === 'completed' && t.taskId) {
    const dl = document.createElement('button');
    dl.className = 'btn-primary';
    dl.type = 'button';
    dl.textContent = '↓ 下载视频';
    dl.title = t.videoBlobId ? '从本机缓存下载' : '会先保存到本机，再开始下载';
    dl.addEventListener('click', () => {
      runButtonTask(dl, '准备下载…', () => downloadVideoTask(t));
    });
    actions.appendChild(dl);

    if (!t.videoBlobId) {
      const cacheBtn = document.createElement('button');
      cacheBtn.className = 'btn-ghost';
      cacheBtn.type = 'button';
      cacheBtn.textContent = '保存到本机';
      cacheBtn.addEventListener('click', async () => {
        await runButtonTask(cacheBtn, '保存中…', async () => {
          await ensureVideoCached(t);
          renderQueue();
          renderVault();
          renderRecent();
          closeModal();
          openModal(t);
        }).catch(err => toast('保存失败：' + err.message, 'bad'));
      });
      actions.appendChild(cacheBtn);
    }
  }
  if (t.kind === 'image' && (t.imageDataUrl || t.imageUrl)) {
    const dl = document.createElement('a');
    dl.className = 'btn-primary';
    dl.href = t.imageDataUrl || t.imageUrl;
    dl.download = `atelier-${pad3(t.folio)}.png`;
    dl.target = '_blank';
    dl.textContent = '↓ 下载图像';
    actions.appendChild(dl);
  }
  const reuse = document.createElement('button');
  reuse.className = 'btn-ghost';
  reuse.textContent = '沿用提示词';
  reuse.addEventListener('click', () => {
    setMode(t.kind);
    setPane('compose');
    $('#' + (t.kind === 'video' ? 'vPrompt' : 'iPrompt')).value = t.prompt;
    updatePromptCount(t.kind);
    closeModal();
  });
  actions.appendChild(reuse);

  // 重试 / 微调重提（任何状态都可重提；失败时尤其有用）
  const retry = document.createElement('button');
  retry.className = 'btn-ghost';
  retry.textContent = t.status === 'failed' ? '重试' : '再生成一次';
  retry.addEventListener('click', async () => {
    closeModal();
    try {
      await resubmitTask(t);
    } catch (err) {
      toast('重试失败：' + err.message, 'bad');
    }
  });
  actions.appendChild(retry);

  const tweak = document.createElement('button');
  tweak.className = 'btn-ghost';
  tweak.textContent = '微调后重提';
  tweak.addEventListener('click', () => {
    loadTaskIntoForm(t);
    closeModal();
    toast('已载入表单，调整后点「生成」', 'ok');
  });
  actions.appendChild(tweak);

  const exportBtn = document.createElement('button');
  exportBtn.className = 'btn-ghost';
  exportBtn.textContent = '导出代码 ⌘';
  exportBtn.addEventListener('click', () => {
    closeModal();
    openCodeForTask(t);
  });
  actions.appendChild(exportBtn);

  const remove = document.createElement('button');
  remove.className = 'btn-ghost';
  remove.textContent = '删除';
  remove.addEventListener('click', async () => {
    await confirmDeleteTask(t);
    closeModal();
  });
  actions.appendChild(remove);

  side.appendChild(actions);
  body.appendChild(side);

  $('#modal').hidden = false;
  $('#modalMask').hidden = false;
}
function closeModal() {
  $('#modal').hidden = true;
  $('#modalMask').hidden = true;
}

// ============================================================
// 重试 / 重提
// ============================================================
async function resubmitTask(t) {
  // 直接用原 params 重新调一次。复用各自的 submit 路径以共享 UI 反馈。
  if (t.kind === 'video') {
    await submitVideoRaw(t.params, t.refs || [], { groupId: t.groupId || null, retryOf: t.localId });
  } else {
    await submitImageRaw(t.params, t.refs || [], { provider: t.provider, endpoint: deriveEndpoint(t), groupId: t.groupId || null, retryOf: t.localId });
  }
}

// ============================================================
// A/B 并行
// ============================================================
const abState = {
  video: { enabled: false, dims: {} },   // dims: { model: ['jimeng-v3-fast', 'jimeng-v3-pro'], size: ['1280x720'] }
  image: { enabled: false, dims: {} },
};

function abFieldsFor(mode) {
  if (mode === 'video') {
    const provider = vProvider;
    return [
      {
        key: 'model',
        name: '模型',
        candidates: VIDEO_MODELS[provider].map(m => ({ value: m.id, label: m.label.split(' · ')[0] })),
      },
      {
        key: 'size',
        name: '尺寸',
        candidates: VIDEO_SIZES[provider].map(s => ({ value: s, label: s })),
      },
      ...(provider === 'sora' ? [{
        key: 'seconds',
        name: '时长（秒）',
        candidates: ['5', '7', '10', '15'].map(s => ({ value: s, label: s + ' 秒' })),
      }] : []),
    ];
  } else {
    if (iProvider === 'openai') {
      return [
        {
          key: 'model',
          name: '模型',
          candidates: IMAGE_PROVIDERS.openai.models.map(m => ({ value: m, label: m })),
        },
        {
          key: 'quality',
          name: '画质',
          candidates: [
            { value: 'low', label: '省时' },
            { value: 'medium', label: '中等' },
            { value: 'high', label: '精细' },
          ],
        },
        {
          key: 'size',
          name: '尺寸',
          candidates: IMAGE_SIZES_OPENAI.map(s => ({ value: s, label: s })),
        },
      ];
    } else {
      const m = $('#iModel').value || 'nanobananapro';
      return [
        {
          key: 'model',
          name: '模型',
          candidates: IMAGE_PROVIDERS.gemini.models.map(x => ({ value: x, label: x })),
        },
        {
          key: 'aspect_ratio',
          name: '画幅比例',
          candidates: (ASPECT_BY_MODEL[m] || ASPECT_BY_MODEL.nanobananapro).map(s => ({ value: s, label: s })),
        },
        {
          key: 'image_size',
          name: '分辨率档',
          candidates: ['1K', '2K', '4K'].map(s => ({ value: s, label: s })),
        },
      ];
    }
  }
}

function abVariantCount(mode) {
  const dims = abState[mode].dims;
  let n = 1;
  for (const k of Object.keys(dims)) {
    const vs = dims[k] || [];
    if (vs.length > 0) n *= vs.length;
  }
  return n;
}

function cartesian(dims) {
  // dims: { key: [v1, v2], key2: [v3] }
  // -> [{key:v1,key2:v3}, {key:v2,key2:v3}]
  const keys = Object.keys(dims).filter(k => (dims[k] || []).length);
  if (!keys.length) return [{}];
  let out = [{}];
  for (const k of keys) {
    const next = [];
    for (const o of out) {
      for (const v of dims[k]) {
        next.push({ ...o, [k]: v });
      }
    }
    out = next;
  }
  return out;
}

function openAbPop(mode) {
  $('#abMode').textContent = mode === 'video' ? '视频' : '图像';
  $('#abPop').dataset.mode = mode;
  $('#abEnabled').checked = abState[mode].enabled;
  renderAbFields(mode);
  $('#abPop').hidden = false;
}
function closeAbPop() { $('#abPop').hidden = true; }

function renderAbFields(mode) {
  const root = $('#abFields');
  root.innerHTML = '';
  const fields = abFieldsFor(mode);
  for (const f of fields) {
    const wrap = document.createElement('div');
    wrap.className = 'ab-field';
    const head = document.createElement('div');
    head.className = 'ab-field-head';
    head.innerHTML = `<span class="ab-field-name">${f.name}</span>`;
    wrap.appendChild(head);
    const chips = document.createElement('div');
    chips.className = 'ab-field-chips';
    const sel = abState[mode].dims[f.key] || [];
    for (const c of f.candidates) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'ab-chip' + (sel.includes(c.value) ? ' is-on' : '');
      chip.innerHTML = `<span class="ab-chip-dot"></span><span>${escapeHtml(c.label)}</span>`;
      chip.addEventListener('click', () => {
        const cur = abState[mode].dims[f.key] || [];
        const idx = cur.indexOf(c.value);
        if (idx >= 0) cur.splice(idx, 1);
        else cur.push(c.value);
        abState[mode].dims[f.key] = cur;
        chip.classList.toggle('is-on');
        $('#abCount').textContent = abVariantCount(mode);
      });
      chips.appendChild(chip);
    }
    wrap.appendChild(chips);
    root.appendChild(wrap);
  }
  $('#abCount').textContent = abVariantCount(mode);
}

function updateAbBadge(mode) {
  const badge = $(mode === 'video' ? '#vAbBadge' : '#iAbBadge');
  if (abState[mode].enabled && abVariantCount(mode) > 1) {
    badge.textContent = `× ${abVariantCount(mode)}`;
    badge.classList.add('is-on');
  } else {
    badge.textContent = '关';
    badge.classList.remove('is-on');
  }
}

async function maybeABSubmitVideo() {
  if (!abState.video.enabled || abVariantCount('video') <= 1) {
    return submitVideo();
  }
  const body = buildVideoBody();
  if (!body.prompt) { toast('提示词不能为空', 'bad'); return; }
  if (!backendCfg.videoUpstream) { toast('视频上游未配置', 'bad'); return; }
  const variants = cartesian(abState.video.dims);
  const groupId = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  toast(`提交 ${variants.length} 个变体并行生成…`, 'ok');
  const refList = refs.video.slice();
  await Promise.all(variants.map(v => {
    const merged = { ...body, ...v };
    const label = Object.entries(v).map(([k, val]) => `${k}=${val}`).join(' · ');
    return submitVideoRaw(merged, refList, { provider: vProvider, groupId, variantLabel: label }).catch(() => null);
  }));
}

async function maybeABSubmitImage() {
  if (!abState.image.enabled || abVariantCount('image') <= 1) {
    return submitImage();
  }
  const built = buildImageRequest();
  if (!built.prompt) { toast('提示词不能为空', 'bad'); return; }
  if (!backendCfg.imageConfigured) { toast('图像上游未配置', 'bad'); return; }
  if (iProvider === 'openai' && iEndpoint === 'edits' && !refs.image.length) {
    toast('图生图模式必须传至少 1 张底图', 'bad');
    return;
  }
  const variants = cartesian(abState.image.dims);
  const groupId = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  toast(`提交 ${variants.length} 个变体并行生成…`, 'ok');
  const refList = refs.image.slice();

  const tasks2 = variants.map(v => {
    const b = JSON.parse(JSON.stringify(built.body));
    if (iProvider === 'openai') {
      Object.assign(b, v);
    } else {
      if (v.model) b.__model = v.model;
      if (!b.generation_config) b.generation_config = { response_modalities: ['IMAGE'], image_config: {} };
      if (!b.generation_config.image_config) b.generation_config.image_config = {};
      if (v.aspect_ratio) b.generation_config.image_config.aspect_ratio = v.aspect_ratio;
      if (v.image_size) b.generation_config.image_config.image_size = v.image_size;
    }
    const label = Object.entries(v).map(([k, val]) => `${k}=${val}`).join(' · ');
    return submitImageRaw(b, refList, { provider: iProvider, endpoint: iEndpoint, groupId, variantLabel: label }).catch(() => null);
  });
  await Promise.all(tasks2);
}

function deriveEndpoint(t) {
  // OpenAI 系：原 path 是 /v1/images/edits 或 /v1/images/generations
  if (t.provider !== 'openai') return null;
  const p = (t.params && (t.params.__endpoint || '')) || '';
  if (p) return p;
  // 兜底：根据 image 字段判断
  return (t.params && t.params.image && t.params.image.length) ? 'edits' : 'generations';
}

function loadTaskIntoForm(t) {
  setMode(t.kind);
  setPane('compose');
  if (t.kind === 'video') {
    setVideoProvider(t.provider || 'sora');
    if (t.model) {
      $('#vModel').value = t.model;
      updateVideoRefHint();
    }
    if (t.size) $('#vSize').value = t.size;
    if (t.seconds) $('#vSeconds').value = t.seconds;
    if (t.params?.generate_audio) $('#vAudio').checked = !!t.params.generate_audio;
    if (t.params?.negative_prompt) $('#vNegative').value = t.params.negative_prompt;
    $('#vPrompt').value = t.prompt;
    refs.video = (t.refs || []).slice();
    renderThumbs('video');
    updatePromptCount('video');
  } else {
    setImageProvider(t.provider || 'openai');
    if (t.model) {
      $('#iModel').value = t.model;
      updateImageFields();
    }
    if (t.provider === 'openai') {
      const ep = deriveEndpoint(t);
      if (ep) {
        iEndpoint = ep;
        $$('#iEndpoint .seg-opt').forEach(b => b.classList.toggle('is-active', b.dataset.val === ep));
      }
      if (t.params?.size) $('#iSize').value = t.params.size;
      if (t.params?.quality) {
        iQuality = t.params.quality;
        $$('#iQuality .seg-opt').forEach(b => b.classList.toggle('is-active', b.dataset.val === iQuality));
      }
    } else {
      const ar = t.params?.generation_config?.image_config?.aspect_ratio;
      const sz = t.params?.generation_config?.image_config?.image_size;
      if (ar && $('#iAspect')) $('#iAspect').value = ar;
      if (sz) {
        iImageSize = sz;
        $$('#iImageSizeSeg .seg-opt').forEach(b => b.classList.toggle('is-active', b.dataset.val === iImageSize));
      }
    }
    $('#iPrompt').value = t.prompt;
    refs.image = (t.refs || []).slice();
    renderThumbs('image');
    updatePromptCount('image');
  }
}

// ============================================================
// DRAWER (settings)
// ============================================================
function openDrawer() {
  $('#drawer').hidden = false;
  $('#drawerMask').hidden = false;
  $('#cfgVideoToken').value = settings.videoToken || '';
  $('#cfgImageToken').value = settings.imageToken || '';
  $('#cfgAutoPoll').checked  = settings.autoPoll;
  $('#cfgAutoVault').checked = settings.autoVault;
  $('#cfgLlmEnabled').checked = settings.llmEnabled;
  renderProfileSelect();
  loadProfileToForm();
  $('#cfgVideoUpstream').value = backendCfg.videoUpstream || '（未配置）';
  $('#cfgImageUpstream').value = backendCfg.imageUpstream || '（未配置）';
}

function renderProfileSelect() {
  const sel = $('#cfgProfileSelect');
  if (!sel) return;
  sel.innerHTML = '';
  if (!settings.llmProfiles.length) {
    const opt = document.createElement('option');
    opt.textContent = '（无配置，点 + 新建）';
    opt.value = '';
    sel.appendChild(opt);
  } else {
    for (const p of settings.llmProfiles) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name || '（无名）'} · ${p.protocol || 'chat_completions'}`;
      if (p.id === settings.activeProfileId) opt.selected = true;
      sel.appendChild(opt);
    }
  }
  // 也更新 chat 顶栏 select
  renderChatProfileSelect();
}

function renderChatProfileSelect() {
  const sel = $('#chatProfileSelect');
  if (!sel) return;
  sel.innerHTML = '';
  if (!settings.llmProfiles.length) {
    const opt = document.createElement('option');
    opt.textContent = '未配置 LLM';
    opt.value = '';
    sel.appendChild(opt);
    return;
  }
  for (const p of settings.llmProfiles) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.name} (${p.model || '?'})`;
    if (p.id === settings.activeProfileId) opt.selected = true;
    sel.appendChild(opt);
  }
}

function loadProfileToForm() {
  const p = getActiveProfile();
  $('#cfgProfileName').value  = p?.name || '';
  $('#cfgLlmBase').value      = p?.base || '';
  $('#cfgLlmKey').value       = p?.key || '';
  $('#cfgLlmModel').value     = p?.model || '';
  $('#cfgLlmPersona').value   = p?.persona || '';
  $('#cfgContextWindow').value = String(p?.contextWindow || 'all');
  $('#cfgContextLimit').value  = p?.contextLimit || 32000;
  const tm = p?.thinkingMode || 'auto';
  $$('#cfgThinkingMode .seg-opt').forEach(b => b.classList.toggle('is-active', b.dataset.val === tm));
  const proto = p?.protocol || 'chat_completions';
  $$('#cfgLlmProtocol .seg-opt').forEach(b => b.classList.toggle('is-active', b.dataset.val === proto));
  // 切换 profile 时隐藏模型下拉（避免旧列表误导）
  const ml = $('#cfgModelList');
  if (ml) ml.hidden = true;
}

function saveCurrentProfileFromForm() {
  let p = getActiveProfile();
  if (!p) {
    p = {
      id: 'pf' + Date.now().toString(36),
      name: '', protocol: 'chat_completions', base: '', key: '', model: '', persona: '',
      contextWindow: 'all', contextLimit: 32000, thinkingMode: 'auto',
    };
    settings.llmProfiles.push(p);
    settings.activeProfileId = p.id;
  }
  p.name = $('#cfgProfileName').value.trim() || ($('#cfgLlmModel').value.trim() || '默认配置');
  p.base = $('#cfgLlmBase').value.trim();
  p.key  = $('#cfgLlmKey').value.trim();
  p.model = $('#cfgLlmModel').value.trim();
  p.persona = $('#cfgLlmPersona').value;
  const cw = $('#cfgContextWindow').value;
  p.contextWindow = cw === 'all' ? 'all' : parseInt(cw, 10) || 'all';
  p.contextLimit = parseInt($('#cfgContextLimit').value, 10) || 32000;
  const tm = $$('#cfgThinkingMode .seg-opt').find(b => b.classList.contains('is-active'));
  p.thinkingMode = tm ? tm.dataset.val : 'auto';
  const proto = $$('#cfgLlmProtocol .seg-opt').find(b => b.classList.contains('is-active'));
  p.protocol = proto ? proto.dataset.val : 'chat_completions';
}
function closeDrawer() {
  $('#drawer').hidden = true;
  $('#drawerMask').hidden = true;
}

// ============================================================
// RECIPES
// ============================================================
const RECIPES = {
  cinematic: '电影感慢推进跟拍镜头，黄金时刻光线，宽银幕变形镜头，浅景深，暖色调调色，空气中飘浮的尘埃粒子，35mm 胶片颗粒',
  product:   '工作室转台拍摄，深灰色无缝背景上的极简产品，柔和顶光配合背光勾勒，缓慢 360° 旋转，超干净构图',
  portrait:  '人物特写，柔和的窗光，中性色背景，浅景深，自然真实的表情，皮肤细节质感，柯达 Portra 胶片色调',
  poster:    '极简风格海报：粗体字体标志，单一主体，偏心构图，理光丝网印刷质感，双色版面，1980 年代杂志设计风',
};
function applyRecipe(key) {
  const txt = RECIPES[key];
  if (!txt) return;
  if (currentMode === 'video') {
    $('#vPrompt').value = txt;
  } else {
    $('#iPrompt').value = txt;
  }
  updatePromptCount(currentMode);
  toast('已套用', 'ok');
}

// ============================================================
// init / wire up
// ============================================================
function updatePromptCount(mode) {
  if (mode === 'video') {
    $('#vPromptCount').textContent = '共 ' + ($('#vPrompt').value || '').length + ' 字';
  } else {
    $('#iPromptCount').textContent = '共 ' + ($('#iPrompt').value || '').length + ' 字';
  }
  $('#folioNo').textContent = `№ ${pad3(editionNo + 1)}`;
}

function bindUI() {
  // mode
  $$('.mode').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  // sidebar nav
  $$('.nav-item').forEach(b => b.addEventListener('click', () => setPane(b.dataset.pane)));
  // queue filter
  $$('#queueFilter .seg-opt').forEach(b => b.addEventListener('click', () => {
    queueFilter = b.dataset.val;
    $$('#queueFilter .seg-opt').forEach(x => x.classList.toggle('is-active', x === b));
    renderQueue();
  }));
  $('#queueRefresh')?.addEventListener('click', () => refreshTaskState({ manual: true }));
  $('#queueClear').addEventListener('click', async () => {
    const ended = tasks.filter(t => FINAL_TASK_STATUSES.has(t.status));
    if (!ended.length) { toast('没有可清理的已结束任务', 'bad'); return; }
    if (!(await uiConfirm(`清理 ${ended.length} 条已结束任务？会删除已完成、失败和已生成未保存记录。`, { okText: '清理', danger: true }))) return;
    for (const t of ended) await deleteTaskRecord(t, { silent: true });
    renderQueue();
    renderVault();
    renderRecent();
    toast(`已清理 ${ended.length} 条任务`, 'ok');
  });
  // 列表 / 网格切换
  $$('#queueView .seg-opt').forEach(b => b.addEventListener('click', async () => {
    settings.queueView = b.dataset.val;
    $$('#queueView .seg-opt').forEach(x => x.classList.toggle('is-active', x === b));
    await saveSettings();
    renderQueue();
  }));

  // video provider seg
  $$('#vProvider .seg-opt').forEach(b => b.addEventListener('click', () => setVideoProvider(b.dataset.val)));
  $('#vModel').addEventListener('change', updateVideoRefHint);
  $$('#vAspectWrap .seg-opt').forEach(b => b.addEventListener('click', () => {
    $$('#vAspectWrap .seg-opt').forEach(x => x.classList.toggle('is-active', x === b));
    $('#vAspect').value = b.dataset.val;
  }));

  // image provider seg
  $$('#iProvider .seg-opt').forEach(b => b.addEventListener('click', () => setImageProvider(b.dataset.val)));
  $('#iModel').addEventListener('change', updateImageFields);
  $$('#iEndpoint .seg-opt').forEach(b => b.addEventListener('click', () => {
    iEndpoint = b.dataset.val;
    $$('#iEndpoint .seg-opt').forEach(x => x.classList.toggle('is-active', x === b));
  }));
  $$('#iQuality .seg-opt').forEach(b => b.addEventListener('click', () => {
    iQuality = b.dataset.val;
    $$('#iQuality .seg-opt').forEach(x => x.classList.toggle('is-active', x === b));
  }));
  $$('#iImageSizeSeg .seg-opt').forEach(b => b.addEventListener('click', () => {
    iImageSize = b.dataset.val;
    $$('#iImageSizeSeg .seg-opt').forEach(x => x.classList.toggle('is-active', x === b));
  }));
  $$('#iCount .seg-opt').forEach(b => b.addEventListener('click', () => {
    iCount = parseInt(b.dataset.val, 10) || 1;
    $$('#iCount .seg-opt').forEach(x => x.classList.toggle('is-active', x === b));
  }));

  // dropzones
  bindDropzone($('#vDrop'), $('#vFile'), $('#vRefUrl'), $('#vFilePick'), 'video');
  bindDropzone($('#iDrop'), $('#iFile'), $('#iRefUrl'), $('#iFilePick'), 'image');

  // submit
  $('#videoForm').addEventListener('submit', (e) => { e.preventDefault(); maybeABSubmitVideo(); });
  $('#imageForm').addEventListener('submit', (e) => { e.preventDefault(); maybeABSubmitImage(); });

  // A/B 入口
  $('#vAbOpen').addEventListener('click', () => openAbPop('video'));
  $('#iAbOpen').addEventListener('click', () => openAbPop('image'));
  $('#abClose').addEventListener('click', closeAbPop);
  $('#abEnabled').addEventListener('change', (e) => {
    const mode = $('#abPop').dataset.mode || 'video';
    abState[mode].enabled = e.target.checked;
    updateAbBadge(mode);
  });

  // reset
  $('#vReset').addEventListener('click', () => {
    $('#vPrompt').value = '';
    refs.video = [];
    renderThumbs('video');
    updatePromptCount('video');
    $('#vStatus').textContent = '';
  });
  $('#iReset').addEventListener('click', () => {
    $('#iPrompt').value = '';
    refs.image = [];
    renderThumbs('image');
    updatePromptCount('image');
    $('#iStatus').textContent = '';
  });

  // prompt count + folio
  $('#vPrompt').addEventListener('input', () => updatePromptCount('video'));
  $('#iPrompt').addEventListener('input', () => updatePromptCount('image'));

  // sample fill
  $$('[data-fill]').forEach(b => b.addEventListener('click', () => {
    const tgt = b.dataset.fill;
    $('#' + tgt).value = b.dataset.text;
    updatePromptCount(tgt === 'vPrompt' ? 'video' : 'image');
  }));

  // LLM tools
  $$('[data-optimize]').forEach(b => b.addEventListener('click', () => {
    openLlmPop(b.dataset.optimize, b.dataset.kind, 'optimize');
  }));
  $$('[data-translate]').forEach(b => b.addEventListener('click', () => {
    const kind = b.dataset.translate === 'vPrompt' ? 'video' : 'image';
    openLlmPop(b.dataset.translate, kind, 'translate');
  }));
  $('#llmPopClose').addEventListener('click', closeLlmPop);
  $('#llmAccept').addEventListener('click', () => {
    const out = $('#llmOut').value.trim();
    if (!out || !llmContext) return;
    $('#' + llmContext.targetId).value = out;
    updatePromptCount(llmContext.kind);
    closeLlmPop();
    toast('已替换提示词', 'ok');
  });
  $('#llmRetry').addEventListener('click', () => {
    if (llmContext) runLlm(llmContext.action);
  });

  // recipes
  $$('.recipe').forEach(b => b.addEventListener('click', () => applyRecipe(b.dataset.recipe)));

  // settings drawer
  $('#openSettings').addEventListener('click', openDrawer);
  $('#closeSettings').addEventListener('click', closeDrawer);
  $('#drawerMask').addEventListener('click', closeDrawer);

  // drawer 宽度拖拽
  {
    const handle = $('#drawerResize');
    const drawer = $('#drawer');
    if (handle) {
      let startX, startW;
      const onMove = (e) => {
        const cx = e.touches ? e.touches[0].clientX : e.clientX;
        const w = startW + (startX - cx);
        const clamped = Math.max(320, Math.min(window.innerWidth * 0.92, w));
        drawer.style.width = clamped + 'px';
      };
      const onUp = () => {
        handle.classList.remove('is-dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onUp);
      };
      const onDown = (e) => {
        e.preventDefault();
        startX = e.touches ? e.touches[0].clientX : e.clientX;
        startW = drawer.offsetWidth;
        handle.classList.add('is-dragging');
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        document.addEventListener('touchmove', onMove);
        document.addEventListener('touchend', onUp);
      };
      handle.addEventListener('mousedown', onDown);
      handle.addEventListener('touchstart', onDown, { passive: false });
    }
  }

  $('#cfgSave').addEventListener('click', async () => {
    settings.videoToken = $('#cfgVideoToken').value.trim();
    settings.imageToken = $('#cfgImageToken').value.trim();
    settings.autoPoll   = $('#cfgAutoPoll').checked;
    settings.autoVault  = $('#cfgAutoVault').checked;
    settings.llmEnabled = $('#cfgLlmEnabled').checked;
    saveCurrentProfileFromForm();
    await saveSettings();
    renderProfileSelect();
    renderChat();
    closeDrawer();
    toast('已保存', 'ok');
  });
  // 协议切换
  $$('#cfgLlmProtocol .seg-opt').forEach(b => b.addEventListener('click', () => {
    $$('#cfgLlmProtocol .seg-opt').forEach(x => x.classList.toggle('is-active', x === b));
    // 协议切换后隐藏旧的模型列表（不同协议返回的模型不同）
    $('#cfgModelList').hidden = true;
  }));

  // 拉取模型列表
  $('#cfgFetchModels').addEventListener('click', async () => {
    const base = $('#cfgLlmBase').value.trim();
    const key = $('#cfgLlmKey').value.trim();
    if (!base) { toast('请先填接口地址', 'bad'); return; }
    if (!key)  { toast('请先填 API 密钥', 'bad'); return; }
    const protoEl = $$('#cfgLlmProtocol .seg-opt').find(b => b.classList.contains('is-active'));
    const proto = protoEl?.dataset.val || 'chat_completions';

    let url, headers, parseFn;
    const baseClean = base.replace(/\/$/, '');
    if (proto === 'gemini') {
      url = 'api/llm/v1beta/models';
      headers = {
        'X-LLM-Upstream': baseClean,
        'x-goog-api-key': key,
        'Authorization': `Bearer ${key}`,
      };
      parseFn = (data) => (data?.models || []).map(m => (m.name || '').replace(/^models\//, '')).filter(Boolean);
    } else if (proto === 'anthropic') {
      url = 'api/llm/v1/models';
      headers = {
        'X-LLM-Upstream': baseClean,
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'Authorization': `Bearer ${key}`,
      };
      parseFn = (data) => (data?.data || data?.models || []).map(m => m.id || m.name).filter(Boolean);
    } else {
      url = 'api/llm/v1/models';
      headers = {
        'X-LLM-Upstream': baseClean,
        'Authorization': `Bearer ${key}`,
      };
      parseFn = (data) => (data?.data || []).map(m => m.id || m.name).filter(Boolean);
    }

    const btn = $('#cfgFetchModels');
    const origText = btn.textContent;
    btn.textContent = '拉取中…';
    btn.classList.add('is-busy');
    try {
      const r = await fetch(url, { headers });
      const text = await r.text();
      if (!r.ok) {
        let detail = text;
        try { detail = JSON.parse(text).error?.message || JSON.parse(text).message || detail; } catch {}
        throw new Error(`HTTP ${r.status} · ${detail.slice(0, 240)}`);
      }
      const data = JSON.parse(text);
      const models = parseFn(data);
      if (!models.length) { toast('上游返回 0 个模型', 'bad'); return; }
      const sel = $('#cfgModelList');
      sel.innerHTML = '';
      sel.hidden = false;
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = `已拉取 ${models.length} 个模型，选一个…`;
      sel.appendChild(blank);
      models.sort();
      for (const m of models) {
        const o = document.createElement('option');
        o.value = m;
        o.textContent = m;
        if (m === $('#cfgLlmModel').value) o.selected = true;
        sel.appendChild(o);
      }
      toast(`拉到 ${models.length} 个模型`, 'ok');
    } catch (err) {
      toast('拉取失败：' + err.message, 'bad');
    } finally {
      btn.textContent = origText;
      btn.classList.remove('is-busy');
    }
  });

  // 选了模型自动填到 input
  $('#cfgModelList').addEventListener('change', (e) => {
    if (e.target.value) $('#cfgLlmModel').value = e.target.value;
  });
  // 思考强度切换
  $$('#cfgThinkingMode .seg-opt').forEach(b => b.addEventListener('click', () => {
    $$('#cfgThinkingMode .seg-opt').forEach(x => x.classList.toggle('is-active', x === b));
  }));
  // Profile 切换 / 新建 / 删除
  $('#cfgProfileSelect').addEventListener('change', async (e) => {
    // 先把表单当前值写入正在编辑的 profile
    saveCurrentProfileFromForm();
    settings.activeProfileId = e.target.value;
    await saveSettings();
    loadProfileToForm();
    renderChatProfileSelect();
  });
  $('#cfgProfileNew').addEventListener('click', async () => {
    saveCurrentProfileFromForm();
    const p = {
      id: 'pf' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
      name: '新配置',
      protocol: 'chat_completions',
      base: '', key: '', model: '', persona: '',
    };
    settings.llmProfiles.push(p);
    settings.activeProfileId = p.id;
    await saveSettings();
    renderProfileSelect();
    loadProfileToForm();
  });
  $('#cfgProfileDel').addEventListener('click', async () => {
    const p = getActiveProfile();
    if (!p) return;
    if (!(await uiConfirm(`删除配置「${p.name}」？`, { okText: '删除', danger: true }))) return;
    settings.llmProfiles = settings.llmProfiles.filter(x => x.id !== p.id);
    settings.activeProfileId = settings.llmProfiles[0]?.id || '';
    await saveSettings();
    renderProfileSelect();
    loadProfileToForm();
    renderChat();
  });
  // chat 顶栏切换 profile
  document.addEventListener('change', async (e) => {
    if (e.target?.id === 'chatProfileSelect') {
      settings.activeProfileId = e.target.value;
      await saveSettings();
      renderChat();
    }
  });
  $('#cfgWipe').addEventListener('click', async () => {
    if (!(await uiConfirm('确定清空所有本地数据（设置 + 任务历史）？此操作不可恢复。', { okText: '清空', danger: true }))) return;
    await wipeAll();
    location.reload();
  });

  // modal
  $('#modalClose').addEventListener('click', closeModal);
  $('#modalMask').addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#llmPop').hidden) closeLlmPop();
    else if (!$('#modal').hidden) closeModal();
    else if (!$('#drawer').hidden) closeDrawer();
  });
}

async function init() {
  await migrateFromLocalStorage();
  await loadSettings();
  migrateLegacyLlmFields();
  await saveSettings();
  applyTheme();
  await loadEdition();
  await loadBackendConfig();
  await reloadTasks({ recover: true });
  await reloadLibrary();
  await loadConversations();
  bindUI();
  setVideoProvider('sora');
  setImageProvider('openai');
  setMode('video');
  setPane('compose');
  // 恢复 queue view
  $$('#queueView .seg-opt').forEach(b => b.classList.toggle('is-active', b.dataset.val === (settings.queueView || 'list')));

  renderQueue();
  renderVault();
  renderLibrary();
  updatePromptCount('video');
  updatePromptCount('image');
  bindHotkeys();
  startHealthLoop();

  // edition tag
  $('#editionNo').textContent = pad3(editionNo);
  $('#editionDate').textContent = new Date().toLocaleDateString('zh-CN');
  const now = new Date();
  $('#folioTime').textContent = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2,'0')}.${String(now.getDate()).padStart(2,'0')}`;

  resumeActiveVideoPolling();
  setInterval(() => refreshTaskState(), TASK_REFRESH_MS);
}

document.addEventListener('DOMContentLoaded', init);

// ============================================================
// 使用教程
// ============================================================
const GUIDE_MD = `# 造影工作台 · 使用教程

一个本地部署的视频与图像生成台，集成：
- **视频生成** — Sora V3 / Veo 3.1
- **图像生成** — OpenAI gpt-image-2 / Gemini nanobanana
- **AI 对话 Agent** — 用自然语言指挥 LLM 调用工具帮你做事

---

## 接口准备

你需要准备一个自托管或第三方 API 网关，并在部署时把 \`UPSTREAM\` 指向该网关。

工作台本身不内置任何商业服务、私有分组或预置密钥。所有 token 都在浏览器本地填写和保存。

---

## 1. 配置视频 / 图像 API

1. 确认你的 \`UPSTREAM\` 支持需要使用的图像、视频和 LLM 路由。
2. 在上游服务中创建对应 token：

| 用途 | 填到工作台哪里 |
|---|---|
| **图像生成** | 「图像接口 Token」 |
| **视频生成** | 「视频接口 Token」 |

3. 回到本工作台点右上 **⊙ 密钥**
4. 在「接口密钥」段填入 token
5. 点「保存」

部署示例：

\`\`\`bash
UPSTREAM=https://your-api.example.com npm start
\`\`\`

---

## 2. 配置 AI Agent（可选但强推荐）

让 AI 用自然语言指挥工作台：

1. 同样在「密钥」抽屉，往下找「**提示词增强 / Agent**」段
2. 勾选「启用提示词增强 / 对话 Agent」
3. 点「**+ 新建**」一个配置：

| 字段 | 推荐值 |
|---|---|
| **配置名称** | \`Claude Sonnet\` / \`GPT-5\` / 随便取 |
| **协议** | 选其一：<br>· **OpenAI · Chat Completions**（兼容大多数模型）<br>· **OpenAI · Responses**（GPT-5 系列必选）<br>· **Anthropic · Messages**（Claude 原生协议）<br>· **Google · Gemini 原生** |
| **Base URL** | 你的 LLM API Base URL，例如 \`https://your-api.example.com/\` |
| **API 密钥** | 对应 LLM 服务的 API key |
| **模型** | 点旁边 **↻ 拉取列表** 看支持的全部模型 |
| **上下文窗口** | 默认「全部」即可，长对话时改小 |
| **思考强度** | 自动 / 关闭 / 低 / 中 / 高（GPT-5、Claude Extended Thinking、DeepSeek-R1、Gemini 2.5 都生效） |

4. 保存 → 切到 **▸ 对话** 就能开始用

可以建多个配置（一个 GPT、一个 Claude、一个 Gemini），对话页右下角下拉切换。

---

## 3. 四个工作区

### ▸ 构图
传统表单式生成。填提示词、选模型、点生成。宽屏右侧自带「最近生成」面板（最多 12 张）。

### ▸ 对话（**强烈推荐**）
跟 AI 聊：

> 「做 4 张冬日图书馆海报」
> 「这张图改成夜晚」（AI 自动找最新作品并 edit）
> 「混合 №3 和 №5 出新的」
> 「8 秒带音频的航拍视频」

AI 调工具时实时显示「⚒ generate_image_openai · 生成参数中…」卡片，完成后图片直接嵌入对话。

### ▸ 任务
所有提交过的任务，列表 / 网格两种视图。视频会自动轮询状态直到完成。失败可一键重试或微调后重提。

### ▸ 档案
已完成的所有作品。「进入多选」可选多个一键打包下载 ZIP（含元数据 JSON）。

---

## 4. 快捷键

| 键 | 动作 |
|---|---|
| **Cmd/Ctrl + K** | 命令面板，搜任何动作 |
| **Cmd/Ctrl + Enter** | 提交当前表单 |
| **Cmd/Ctrl + ,** | 打开密钥设置 |
| **Cmd/Ctrl + L** | 切换列表/网格视图 |
| **/** | 聚焦当前提示词输入框 |
| **g** 然后 **c / a / q / v / s** | Vim 风跳转：构图 / 对话 / 任务 / 档案 / 设置 |
| **1 / 2** | 切换视频 / 图像模式 |
| **Esc** | 关闭最上层弹窗 |

---

## 5. 斜杠命令（对话页输入框打 \`/\`）

- \`/compress\` — 让 LLM 把整段历史压缩为一段摘要（节省 token）
- \`/clear\` — 清空当前对话
- \`/new\` — 新建对话
- \`/title 新名字\` — 重命名
- \`/model claude\` — 模糊匹配切 LLM 配置
- \`/think low/medium/high/off/auto\` — 调思考强度
- \`/window 20 / all\` — 调上下文窗口
- \`/export\` — 当前对话导出为 Markdown
- \`/debug\` — 切换调试面板
- \`/help\` — 列出全部命令

---

## 6. 实用技巧

- **提示词库**：常用 prompt 点左侧栏「**+**」存起来，下次一键套用，支持 \`{变量}\` 占位
- **看图写词**：上传参考图 → 鼠标悬停缩略图 → 点「看图写词」让 vision LLM 反推 prompt
- **优化 ↗**：提示词框上方有按钮，让 LLM 把你的中文需求改写成更专业的英文 prompt
- **A/B 并行**：构图页底部「A/B 并行 · 关」点开，可勾多个参数维度，一次跑笛卡尔积
- **多张图**：OpenAI 图像表单底部「张数」选 4/6，单次返回多张共享同一个 group
- **导出代码**：「导出代码 ⌘」按钮拿当前请求的 curl / Python / JS 代码
- **暗色主题**：顶栏 **☉/☀/☾** 按钮循环切换跟随系统 / 浅色 / 深色

---

## 7. 数据存哪里？

**全部存在浏览器本地 IndexedDB**：
- 所有 token、LLM 配置、对话历史、生成任务记录、参考图、提示词库 — 都不上传任何后端
- 后端主要是 HTTP 代理；图像生成响应会短期缓存到服务端用于刷新恢复，默认 24 小时后过期
- 想搬到另一台电脑用 → 「密钥」抽屉「清空本地数据」或浏览器开发者工具直接清 IndexedDB

---

## 8. 出问题怎么办？

- **视频不播放** → 检查「密钥」里视频 token 是否填了（浏览器 \`<video>\` 标签靠 \`?_token=\` query 带 auth）
- **AI 对话空消息** → 对话页右上「调试 ▾」展开看响应原文。常见：模型不支持 tools（换 \`gpt-4o-mini\` 或 \`claude-sonnet-4-6\`）/ 选错协议（GPT-5 系列必须用 Responses）
- **edit_image 拒绝** → 该作品的临时外链可能过期。新生成的图会自动缓存 base64，旧图重新生成一遍即可

更多问题去工作台命令面板 (⌘K) 搜 \`/help\` 看完整功能列表。`;

function openGuide() {
  $('#guideMask').hidden = false;
  $('#guideDrawer').hidden = false;
  $('#guideBody').innerHTML = renderMarkdown(GUIDE_MD);
}
function closeGuide() {
  $('#guideMask').hidden = true;
  $('#guideDrawer').hidden = true;
}

// ============================================================
// LLM 通用调用（兼容 JSON 和 SSE 流式）+ 调试日志
// ============================================================
const llmDebugLog = [];
const DEBUG_MAX = 12;

function pushDebug(entry) {
  llmDebugLog.unshift(entry);
  if (llmDebugLog.length > DEBUG_MAX) llmDebugLog.length = DEBUG_MAX;
  if (settings.chatDebug) console.log('[llm-debug]', entry);
  renderDebugPanel();
}

function renderDebugPanel() {
  const list = $('#chatDebugList');
  if (!list) return;
  list.innerHTML = '';
  if (!llmDebugLog.length) {
    list.innerHTML = '<li class="chat-debug-empty">尚无调用记录。发一条消息后会出现。</li>';
    return;
  }
  for (const e of llmDebugLog) {
    const li = document.createElement('li');
    li.className = 'chat-debug-entry' + (e.error ? ' is-failed' : (e.warn ? ' is-warn' : ''));
    const head = document.createElement('div');
    head.className = 'chat-debug-summary';
    const icon = e.error ? '✕' : (e.warn ? '!' : '✓');
    head.innerHTML = `
      <span class="chat-debug-icon">${icon}</span>
      <span class="chat-debug-method">POST /v1/chat/completions</span>
      <span>${e.summary || ''}</span>
      <span class="chat-debug-status">${e.httpStatus || ''} · ${e.elapsedMs}ms · ${new Date(e.at).toLocaleTimeString()}</span>
    `;
    head.addEventListener('click', () => li.classList.toggle('is-open'));
    li.appendChild(head);
    const body = document.createElement('div');
    body.className = 'chat-debug-body';
    body.innerHTML = `
      ${e.diagnostic ? `
        <div class="chat-debug-section">
          <div class="chat-debug-section-label">⚠ 诊断</div>
          <div class="chat-debug-diag">
            <div class="chat-debug-diag-title">${escapeHtml(e.diagnostic.title)}</div>
            <div class="chat-debug-diag-detail">${escapeHtml(e.diagnostic.detail)}</div>
            <button type="button" class="btn-primary chat-debug-diag-btn" data-act="open-keys">打开密钥设置去换模型</button>
          </div>
        </div>` : ''}
      <div class="chat-debug-section">
        <div class="chat-debug-section-label">请求 body（messages 摘要 + tools）</div>
        <pre class="chat-debug-pre">${escapeHtml(e.requestPreview || '')}</pre>
      </div>
      <div class="chat-debug-section">
        <div class="chat-debug-section-label">响应原文（前 ${e.rawTruncatedAt || 0} 字符）</div>
        <pre class="chat-debug-pre">${escapeHtml(e.responseRaw || '(无)')}</pre>
      </div>
      <div class="chat-debug-section">
        <div class="chat-debug-section-label">解析结果</div>
        <pre class="chat-debug-pre">${escapeHtml(e.parsedPreview || '(无)')}</pre>
      </div>
      ${e.error ? `<div class="chat-debug-section"><div class="chat-debug-section-label">错误</div><pre class="chat-debug-pre">${escapeHtml(e.error)}</pre></div>` : ''}
    `;
    body.querySelectorAll('[data-act="open-keys"]').forEach(b => {
      b.addEventListener('click', (ev) => { ev.stopPropagation(); openDrawer(); });
    });
    li.appendChild(body);
    list.appendChild(li);
  }
}

function extractSseUsage(text) {
  const lines = text.split(/\r?\n/);
  let last = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload);
      if (obj?.usage) last = obj.usage;
    } catch {}
  }
  return last;
}

function parseSseChatResponse(text) {
  const result = { content: '', tool_calls: [] };  const toolByIdx = {};
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let obj;
    try { obj = JSON.parse(payload); } catch { continue; }
    const choice = obj?.choices?.[0];
    if (!choice) continue;
    if (choice.message) {
      if (choice.message.content) result.content += choice.message.content;
      if (choice.message.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          const idx = tc.index ?? Object.keys(toolByIdx).length;
          toolByIdx[idx] = { id: tc.id, type: tc.type || 'function', function: { name: tc.function?.name || '', arguments: tc.function?.arguments || '' } };
        }
      }
    }
    const d = choice.delta;
    if (!d) continue;
    if (typeof d.content === 'string') result.content += d.content;
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolByIdx[idx]) toolByIdx[idx] = { id: tc.id || '', type: tc.type || 'function', function: { name: '', arguments: '' } };
        if (tc.id) toolByIdx[idx].id = tc.id;
        if (tc.function?.name) toolByIdx[idx].function.name += tc.function.name;
        if (tc.function?.arguments) toolByIdx[idx].function.arguments += tc.function.arguments;
      }
    }
  }
  const keys = Object.keys(toolByIdx).sort((a, b) => +a - +b);
  for (const k of keys) result.tool_calls.push(toolByIdx[k]);
  if (!result.tool_calls.length) delete result.tool_calls;
  return result;
}

async function callLlmChat(body, opts = {}) {
  const cfg = getActiveLlmConfig();
  const proto = cfg.protocol || 'chat_completions';
  if (!body.model && cfg.model) body = { ...body, model: cfg.model };
  if (proto === 'responses') return callResponsesApi(body, opts);
  if (proto === 'anthropic') return callAnthropic(body, opts);
  if (proto === 'gemini')    return callGemini(body, opts);
  return callChatCompletions(body, opts);
}

async function callChatCompletions(body, opts = {}) {
  const t0 = Date.now();
  const onProgress = opts.onProgress;
  // 加入思考强度（DeepSeek-R1 / GPT-5 chat completions / OpenAI 兼容扩展）
  const cfg0 = getActiveLlmConfig();
  if (cfg0.thinkingMode && cfg0.thinkingMode !== 'auto') {
    if (cfg0.thinkingMode === 'off') {
      // 一些镜像支持 reasoning_effort=minimal 关闭
      body = { ...body, reasoning_effort: 'minimal' };
    } else {
      body = { ...body, reasoning_effort: cfg0.thinkingMode };
    }
  }
  const entry = {
    at: Date.now(),
    requestPreview: JSON.stringify({
      model: body.model,
      temperature: body.temperature,
      tool_choice: body.tool_choice,
      tools: body.tools ? body.tools.map(t => t.function?.name) : undefined,
      messages: body.messages?.map(m => {
        if (typeof m.content === 'string') {
          return { role: m.role, content: m.content.length > 240 ? m.content.slice(0, 240) + '...<truncated>' : m.content, name: m.name, tool_call_id: m.tool_call_id, tool_calls: m.tool_calls?.map(tc => ({ name: tc.function?.name, args: tc.function?.arguments?.slice(0, 120) })) };
        }
        if (Array.isArray(m.content)) {
          return { role: m.role, content: m.content.map(c => c.type === 'image_url' ? '[image]' : c.text?.slice(0, 200)) };
        }
        return { role: m.role };
      }),
    }, null, 2),
    elapsedMs: 0,
    httpStatus: 0,
    responseRaw: '',
    rawTruncatedAt: 0,
    parsedPreview: '',
    error: null,
    warn: null,
    summary: '',
  };
  const cfg = getActiveLlmConfig();
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${cfg.key}`,
    'X-LLM-Upstream': cfg.base.replace(/\/$/, ''),
    ...(opts.headers || {}),
  };
  // 显式请求流式
  const sendBody = { ...body, stream: true };
  try {
    const r = await fetch('api/llm/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(sendBody),
      signal: opts.signal,
    });
    entry.httpStatus = r.status;
    if (!r.ok) {
      const text = await r.text();
      entry.elapsedMs = Date.now() - t0;
      entry.responseRaw = text.slice(0, 4000);
      entry.rawTruncatedAt = Math.min(text.length, 4000);
      let detail = text;
      try { detail = JSON.parse(text).error?.message || detail; } catch {}
      entry.error = `HTTP ${r.status} · ${detail.slice(0, 400)}`;
      entry.summary = `HTTP ${r.status} 失败`;
      throw new Error(entry.error);
    }
    const result = await readChatStream(r, onProgress);
    entry.elapsedMs = Date.now() - t0;
    entry.responseRaw = result.rawSnippet;
    entry.rawTruncatedAt = result.rawSnippet.length;
    entry.summary = `${result.mode} · content=${result.parsed.content?.length || 0}字 · tools=${result.parsed.tool_calls?.length || 0}`;
    entry.parsedPreview = JSON.stringify({
      content: result.parsed.content ? (result.parsed.content.length > 600 ? result.parsed.content.slice(0, 600) + '...' : result.parsed.content) : '',
      tool_calls: result.parsed.tool_calls?.map(tc => ({ id: tc.id, name: tc.function?.name, args: typeof tc.function?.arguments === 'string' ? tc.function.arguments.slice(0, 300) : tc.function?.arguments })),
      usage: result.usage,
    }, null, 2);
    const empty = !result.parsed.content && (!result.parsed.tool_calls || !result.parsed.tool_calls.length);
    const noOutput = (result.usage && (result.usage.completion_tokens === 0 || result.usage.output_tokens === 0));
    if (empty && body.tools && body.tools.length && noOutput) {
      entry.diagnostic = {
        kind: 'tools_not_supported',
        title: '模型疑似不支持 tools / function calling',
        detail: `上游接收了 ${result.usage?.prompt_tokens || '?'} 输入 token，但 completion_tokens=0 且 choices 为空。\n` +
                `建议：换协议为 Responses API（针对 gpt-5 系列），或换模型 gpt-4o-mini · claude-sonnet-4-6 · deepseek-chat`,
      };
      entry.warn = entry.diagnostic.title;
      entry.summary = '⚠ ' + entry.diagnostic.title;
    }
    return result.parsed;
  } catch (err) {
    if (!entry.error) entry.error = err.message;
    if (!entry.summary) entry.summary = '失败';
    throw err;
  } finally {
    pushDebug(entry);
  }
}

// 流式读 chat completions 响应
async function readChatStream(response, onProgress) {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return processFallback(text, onProgress);
  }
  const decoder = new TextDecoder();
  let buffer = '';
  let rawAll = '';
  const aggregated = { content: '', reasoning: '' };
  const toolByIdx = {};
  let usage = null;
  let mode = 'SSE 流';
  let sawAnySse = false;

  const emit = () => {
    const tool_calls = [];
    const keys = Object.keys(toolByIdx).sort((a, b) => +a - +b);
    for (const k of keys) tool_calls.push(toolByIdx[k]);
    onProgress?.({
      content: aggregated.content,
      reasoning: aggregated.reasoning,
      tool_calls: tool_calls.length ? tool_calls : undefined,
    });
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    rawAll += chunk;
    buffer += chunk;
    // 按 \n\n 分块（SSE 标准是空行分割事件）
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      processBlock(block);
    }
  }
  // 最后剩余 buffer
  if (buffer.trim()) processBlock(buffer);

  function processBlock(block) {
    const lines = block.split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      sawAnySse = true;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      if (obj?.usage) usage = obj.usage;
      const choice = obj?.choices?.[0];
      if (!choice) continue;
      // 兼容把完整 message 塞进一个 chunk 的情况
      if (choice.message) {
        if (choice.message.content) aggregated.content += choice.message.content;
        if (choice.message.tool_calls) {
          for (const tc of choice.message.tool_calls) {
            const k = tc.index ?? Object.keys(toolByIdx).length;
            toolByIdx[k] = { id: tc.id || '', type: tc.type || 'function', function: { name: tc.function?.name || '', arguments: tc.function?.arguments || '' } };
          }
        }
      }
      const d = choice.delta;
      if (d) {
        if (typeof d.content === 'string') aggregated.content += d.content;
        // DeepSeek-R1 风格的思考字段（也兼容 reasoning）
        if (typeof d.reasoning_content === 'string') aggregated.reasoning += d.reasoning_content;
        if (typeof d.reasoning === 'string') aggregated.reasoning += d.reasoning;
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            const k = tc.index ?? 0;
            if (!toolByIdx[k]) toolByIdx[k] = { id: tc.id || '', type: tc.type || 'function', function: { name: '', arguments: '' } };
            if (tc.id) toolByIdx[k].id = tc.id;
            if (tc.function?.name) toolByIdx[k].function.name += tc.function.name;
            if (tc.function?.arguments) toolByIdx[k].function.arguments += tc.function.arguments;
          }
        }
      }
    }
    emit();
  }

  // 兜底：如果没有任何 SSE，按 JSON 处理
  if (!sawAnySse) {
    return processFallback(rawAll, onProgress);
  }

  const final_tool_calls = [];
  const keys = Object.keys(toolByIdx).sort((a, b) => +a - +b);
  for (const k of keys) final_tool_calls.push(toolByIdx[k]);
  const parsed = { content: aggregated.content };
  if (aggregated.reasoning) parsed.reasoning = aggregated.reasoning;
  if (final_tool_calls.length) parsed.tool_calls = final_tool_calls;
  const rawSnippet = rawAll.length > 4000 ? rawAll.slice(0, 4000) + `\n... (共 ${rawAll.length} 字节，已截断)` : rawAll;
  return { parsed, usage, mode, rawSnippet };
}

function processFallback(text, onProgress) {
  // 非流式 JSON
  let parsed = { content: '' };
  let usage = null;
  try {
    const data = JSON.parse(text);
    usage = data?.usage || null;
    const msg = data?.choices?.[0]?.message;
    if (msg) {
      parsed = { content: msg.content || '', tool_calls: msg.tool_calls };
    }
  } catch {
    // 解析失败兜底
    parsed = parseSseChatResponse(text);
  }
  onProgress?.(parsed);
  const rawSnippet = text.length > 4000 ? text.slice(0, 4000) + `\n... (共 ${text.length} 字节，已截断)` : text;
  return { parsed, usage, mode: '非流式 JSON', rawSnippet };
}

// ============================================================
// Responses API 适配器（OpenAI 新版 /v1/responses，GPT-5 系列）
// ============================================================
function buildResponsesRequest(chatBody) {
  // chatBody: { model, messages, tools, tool_choice, temperature }
  // 把 messages 拆为：instructions(system) + input[]
  // tools 扁平化
  let instructions = '';
  const input = [];
  for (const m of chatBody.messages || []) {
    if (m.role === 'system') {
      instructions = (instructions ? instructions + '\n\n' : '') + (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
      continue;
    }
    if (m.role === 'user') {
      // 多模态：content 数组保留 type/text/image_url 结构，但 Responses 的图片是 type: input_image, image_url 字段
      if (Array.isArray(m.content)) {
        const parts = m.content.map(p => {
          if (p.type === 'text')      return { type: 'input_text', text: p.text };
          if (p.type === 'image_url') return { type: 'input_image', image_url: p.image_url?.url || p.image_url };
          return p;
        });
        input.push({ role: 'user', content: parts });
      } else {
        input.push({ role: 'user', content: m.content || '' });
      }
      continue;
    }
    if (m.role === 'assistant') {
      // 文本 + tool_calls 在 Responses API 里要分两种 output item
      if (m.content) input.push({ role: 'assistant', content: m.content });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function?.name,
            arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {}),
          });
        }
      }
      continue;
    }
    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      });
      continue;
    }
  }
  // tools 扁平化：去掉外层 function 包裹
  const tools = (chatBody.tools || []).map(t => {
    if (t.type === 'function' && t.function) {
      return {
        type: 'function',
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      };
    }
    return t;
  });
  const out = {
    model: chatBody.model,
    input,
    instructions: instructions || undefined,
    tools: tools.length ? tools : undefined,
    tool_choice: chatBody.tool_choice,
    temperature: chatBody.temperature,
  };
  // 思考强度
  const cfg = getActiveLlmConfig();
  if (cfg.thinkingMode && cfg.thinkingMode !== 'auto' && cfg.thinkingMode !== 'off') {
    out.reasoning = { effort: cfg.thinkingMode };
  }
  return out;
}

function parseResponsesNonStream(data) {
  const out = { content: '', tool_calls: [] };
  const items = data?.output || [];
  for (const it of items) {
    if (it.type === 'message' || it.role === 'assistant') {
      const parts = it.content || [];
      for (const p of parts) {
        if (p.type === 'output_text' || p.type === 'text') {
          out.content += p.text || '';
        }
      }
    } else if (it.type === 'function_call') {
      out.tool_calls.push({
        id: it.call_id || it.id,
        type: 'function',
        function: { name: it.name, arguments: it.arguments || '' },
      });
    }
  }
  if (!out.tool_calls.length) delete out.tool_calls;
  return out;
}

function parseResponsesSse(text) {
  // Responses SSE 用 event: ... + data: ... 多种事件类型
  // 我们关心：
  // - response.output_text.delta { delta }
  // - response.output_item.added { item: { type:'function_call', name, call_id, arguments? } }
  // - response.function_call_arguments.delta { delta, item_id }
  // - response.function_call_arguments.done { arguments, item_id }
  // - response.completed
  const out = { content: '', tool_calls: [] };
  const toolByItemId = {};   // item_id -> { id, name, arguments }
  let nextToolIndex = 0;

  const lines = text.split(/\r?\n/);
  let curEvent = null;
  for (const raw of lines) {
    const line = raw;
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      curEvent = line.slice(6).trim();
      continue;
    }
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let obj;
    try { obj = JSON.parse(payload); } catch { continue; }

    // 用 type 字段判别（Responses 的 SSE data 里也有 type）
    const evType = obj.type || curEvent || '';

    if (evType.endsWith('output_text.delta') || evType === 'response.output_text.delta') {
      if (typeof obj.delta === 'string') out.content += obj.delta;
      else if (obj.delta && typeof obj.delta.text === 'string') out.content += obj.delta.text;
    } else if (evType.endsWith('output_text.done')) {
      // ignore
    } else if (evType.endsWith('output_item.added') || evType === 'response.output_item.added') {
      const item = obj.item || {};
      if (item.type === 'function_call') {
        const k = item.id || ('item_' + nextToolIndex++);
        toolByItemId[k] = { id: item.call_id || item.id, name: item.name || '', arguments: item.arguments || '' };
      } else if (item.type === 'message' && Array.isArray(item.content)) {
        for (const p of item.content) {
          if (p.type === 'output_text' && p.text) out.content += p.text;
        }
      }
    } else if (evType.endsWith('function_call_arguments.delta') || evType === 'response.function_call_arguments.delta') {
      const k = obj.item_id || Object.keys(toolByItemId).pop();
      if (!toolByItemId[k]) toolByItemId[k] = { id: obj.call_id || k, name: obj.name || '', arguments: '' };
      if (typeof obj.delta === 'string') toolByItemId[k].arguments += obj.delta;
    } else if (evType.endsWith('function_call_arguments.done') || evType === 'response.function_call_arguments.done') {
      const k = obj.item_id || Object.keys(toolByItemId).pop();
      if (toolByItemId[k] && typeof obj.arguments === 'string') {
        toolByItemId[k].arguments = obj.arguments;
      }
    } else if (evType === 'response.completed' || evType.endsWith('response.completed')) {
      // 可能包含完整 response 对象，兜底解析
      if (obj.response) {
        const merged = parseResponsesNonStream(obj.response);
        if (!out.content && merged.content) out.content = merged.content;
        if (merged.tool_calls?.length && !Object.keys(toolByItemId).length) {
          for (const tc of merged.tool_calls) {
            toolByItemId['_' + Object.keys(toolByItemId).length] = { id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments };
          }
        }
      }
    } else {
      // 兜底：如果 obj.choices 存在，按 Chat Completions chunk 处理（有些中转混用协议）
      const choice = obj?.choices?.[0];
      if (choice?.delta?.content) out.content += choice.delta.content;
      if (obj?.output) {
        const merged = parseResponsesNonStream(obj);
        if (!out.content && merged.content) out.content = merged.content;
      }
    }
  }
  for (const k of Object.keys(toolByItemId)) {
    const t = toolByItemId[k];
    if (!t.name && !t.arguments) continue;
    out.tool_calls.push({ id: t.id || k, type: 'function', function: { name: t.name, arguments: t.arguments } });
  }
  if (!out.tool_calls.length) delete out.tool_calls;
  return out;
}

async function callResponsesApi(chatBody, opts = {}) {
  const reqBody = buildResponsesRequest(chatBody);
  reqBody.stream = true;
  const onProgress = opts.onProgress;
  const t0 = Date.now();
  const entry = {
    at: Date.now(),
    requestPreview: JSON.stringify({
      protocol: 'responses',
      model: reqBody.model,
      instructions: reqBody.instructions?.slice(0, 240) + (reqBody.instructions?.length > 240 ? '...' : ''),
      tools: reqBody.tools?.map(t => t.name),
      tool_choice: reqBody.tool_choice,
      temperature: reqBody.temperature,
      input: reqBody.input?.map(it => {
        if (it.type === 'function_call') return { type: 'function_call', name: it.name, call_id: it.call_id, args: (it.arguments || '').slice(0, 120) };
        if (it.type === 'function_call_output') return { type: 'function_call_output', call_id: it.call_id, output: typeof it.output === 'string' ? it.output.slice(0, 240) : it.output };
        if (Array.isArray(it.content)) return { role: it.role, content: it.content.map(c => c.type === 'input_image' ? '[image]' : c.text?.slice(0, 200)) };
        return { role: it.role, content: typeof it.content === 'string' ? it.content.slice(0, 240) : it.content };
      }),
    }, null, 2),
    elapsedMs: 0,
    httpStatus: 0,
    responseRaw: '',
    rawTruncatedAt: 0,
    parsedPreview: '',
    error: null,
    warn: null,
    summary: '',
  };
  const cfg = getActiveLlmConfig();
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${cfg.key}`,
    'X-LLM-Upstream': cfg.base.replace(/\/$/, ''),
    ...(opts.headers || {}),
  };
  try {
    const r = await fetch('api/llm/v1/responses', {
      method: 'POST',
      headers,
      body: JSON.stringify(reqBody),
      signal: opts.signal,
    });
    entry.httpStatus = r.status;
    if (!r.ok) {
      const text = await r.text();
      entry.elapsedMs = Date.now() - t0;
      entry.responseRaw = text.slice(0, 4000);
      entry.rawTruncatedAt = Math.min(text.length, 4000);
      let detail = text;
      try { detail = JSON.parse(text).error?.message || detail; } catch {}
      entry.error = `HTTP ${r.status} · ${detail.slice(0, 400)}`;
      entry.summary = `HTTP ${r.status} 失败`;
      throw new Error(entry.error);
    }
    const result = await readResponsesStream(r, onProgress);
    entry.elapsedMs = Date.now() - t0;
    entry.responseRaw = result.rawSnippet;
    entry.rawTruncatedAt = result.rawSnippet.length;
    entry.summary = `${result.mode} · content=${result.parsed.content?.length || 0}字 · tools=${result.parsed.tool_calls?.length || 0}`;
    entry.parsedPreview = JSON.stringify({
      content: result.parsed.content ? (result.parsed.content.length > 600 ? result.parsed.content.slice(0, 600) + '...' : result.parsed.content) : '',
      tool_calls: result.parsed.tool_calls?.map(tc => ({ id: tc.id, name: tc.function?.name, args: typeof tc.function?.arguments === 'string' ? tc.function.arguments.slice(0, 300) : tc.function?.arguments })),
    }, null, 2);
    if (!result.parsed.content && (!result.parsed.tool_calls || !result.parsed.tool_calls.length)) {
      entry.warn = '解析后内容为空，请展开查看响应原文';
      entry.summary = '⚠ ' + entry.summary;
    }
    return result.parsed;
  } catch (err) {
    if (!entry.error) entry.error = err.message;
    if (!entry.summary) entry.summary = '失败';
    throw err;
  } finally {
    pushDebug(entry);
  }
}

async function readResponsesStream(response, onProgress) {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    let parsed;
    try { parsed = parseResponsesNonStream(JSON.parse(text)); }
    catch { parsed = parseResponsesSse(text); }
    onProgress?.(parsed);
    return { parsed, mode: '非流式', rawSnippet: text.slice(0, 4000) };
  }
  const decoder = new TextDecoder();
  let buffer = '';
  let rawAll = '';
  const aggregated = { content: '', reasoning: '' };
  const toolByItemId = {};
  let nextIdx = 0;
  let sawSse = false;

  const snapshot = () => {
    const tool_calls = [];
    for (const k of Object.keys(toolByItemId)) {
      const t = toolByItemId[k];
      if (!t.name && !t.arguments) continue;
      tool_calls.push({ id: t.id || k, type: 'function', function: { name: t.name, arguments: t.arguments } });
    }
    const out = { content: aggregated.content };
    if (aggregated.reasoning) out.reasoning = aggregated.reasoning;
    if (tool_calls.length) out.tool_calls = tool_calls;
    return out;
  };
  const emit = () => onProgress?.(snapshot());

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    rawAll += chunk;
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      processBlock(block);
    }
  }
  if (buffer.trim()) processBlock(buffer);

  function processBlock(block) {
    const lines = block.split(/\r?\n/);
    let curEvent = null;
    for (const raw of lines) {
      const line = raw;
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) { curEvent = line.slice(6).trim(); continue; }
      if (!line.startsWith('data:')) continue;
      sawSse = true;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      const evType = obj.type || curEvent || '';

      if (evType.endsWith('output_text.delta')) {
        if (typeof obj.delta === 'string') aggregated.content += obj.delta;
        else if (obj.delta?.text) aggregated.content += obj.delta.text;
      } else if (evType.endsWith('reasoning_summary_text.delta') || evType.endsWith('reasoning.delta') || evType.endsWith('reasoning_text.delta')) {
        if (typeof obj.delta === 'string') aggregated.reasoning += obj.delta;
        else if (obj.delta?.text) aggregated.reasoning += obj.delta.text;
      } else if (evType.endsWith('output_item.added')) {
        const item = obj.item || {};
        if (item.type === 'function_call') {
          const k = item.id || ('item_' + nextIdx++);
          toolByItemId[k] = { id: item.call_id || item.id, name: item.name || '', arguments: item.arguments || '' };
        } else if (item.type === 'message' && Array.isArray(item.content)) {
          for (const p of item.content) if (p.type === 'output_text' && p.text) aggregated.content += p.text;
        } else if (item.type === 'reasoning' && Array.isArray(item.summary)) {
          for (const p of item.summary) if (p.type === 'summary_text' && p.text) aggregated.reasoning += p.text;
        }
      } else if (evType.endsWith('function_call_arguments.delta')) {
        const k = obj.item_id || Object.keys(toolByItemId).pop();
        if (!toolByItemId[k]) toolByItemId[k] = { id: obj.call_id || k, name: obj.name || '', arguments: '' };
        if (typeof obj.delta === 'string') toolByItemId[k].arguments += obj.delta;
      } else if (evType.endsWith('function_call_arguments.done')) {
        const k = obj.item_id || Object.keys(toolByItemId).pop();
        if (toolByItemId[k] && typeof obj.arguments === 'string') toolByItemId[k].arguments = obj.arguments;
      } else if (evType.endsWith('response.completed')) {
        if (obj.response) {
          const merged = parseResponsesNonStream(obj.response);
          if (!aggregated.content && merged.content) aggregated.content = merged.content;
          if (merged.tool_calls && !Object.keys(toolByItemId).length) {
            for (const tc of merged.tool_calls) {
              toolByItemId['_' + Object.keys(toolByItemId).length] = { id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments };
            }
          }
        }
      }
    }
    emit();
  }

  if (!sawSse) {
    let parsed;
    try { parsed = parseResponsesNonStream(JSON.parse(rawAll)); }
    catch { parsed = parseResponsesSse(rawAll); }
    onProgress?.(parsed);
    return { parsed, mode: '非流式', rawSnippet: rawAll.slice(0, 4000) };
  }

  const parsed = snapshot();
  const rawSnippet = rawAll.length > 4000 ? rawAll.slice(0, 4000) + `\n... (共 ${rawAll.length} 字节，已截断)` : rawAll;
  return { parsed, mode: 'Responses SSE', rawSnippet };
}

// ============================================================
// Anthropic Messages 适配器（Claude 原生 /v1/messages）
// ============================================================
function buildAnthropicRequest(chatBody) {
  let system = '';
  const messages = [];
  let lastAssistantToolCalls = null; // 用来匹配 tool 消息

  for (const m of chatBody.messages || []) {
    if (m.role === 'system') {
      system = (system ? system + '\n\n' : '') + (typeof m.content === 'string' ? m.content : '');
      continue;
    }
    if (m.role === 'user') {
      if (Array.isArray(m.content)) {
        const parts = m.content.map(p => {
          if (p.type === 'text')      return { type: 'text', text: p.text };
          if (p.type === 'image_url') {
            const url = p.image_url?.url || p.image_url;
            // data URL → base64 source
            const dm = /^data:([^;]+);base64,(.+)$/.exec(url || '');
            if (dm) return { type: 'image', source: { type: 'base64', media_type: dm[1], data: dm[2] } };
            return { type: 'image', source: { type: 'url', url } };
          }
          return null;
        }).filter(Boolean);
        messages.push({ role: 'user', content: parts });
      } else {
        messages.push({ role: 'user', content: m.content || '' });
      }
      continue;
    }
    if (m.role === 'assistant') {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      if (Array.isArray(m.tool_calls)) {
        lastAssistantToolCalls = m.tool_calls;
        for (const tc of m.tool_calls) {
          let input = {};
          try { input = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {}); } catch {}
          content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
        }
      }
      messages.push({ role: 'assistant', content });
      continue;
    }
    if (m.role === 'tool') {
      // Anthropic: tool_result 必须放在 user 消息里
      const last = messages[messages.length - 1];
      const part = { type: 'tool_result', tool_use_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(part);
      } else {
        messages.push({ role: 'user', content: [part] });
      }
      continue;
    }
  }
  const tools = (chatBody.tools || []).map(t => {
    if (t.type === 'function' && t.function) {
      return { name: t.function.name, description: t.function.description, input_schema: t.function.parameters };
    }
    return t;
  });
  const out = {
    model: chatBody.model,
    max_tokens: chatBody.max_tokens || 4096,
    messages,
    system: system || undefined,
    temperature: chatBody.temperature,
    tools: tools.length ? tools : undefined,
    tool_choice: chatBody.tool_choice && chatBody.tool_choice !== 'auto' ? { type: chatBody.tool_choice } : undefined,
  };
  // 思考预算（Anthropic Extended Thinking）
  const cfg = getActiveLlmConfig();
  if (cfg.thinkingMode && cfg.thinkingMode !== 'auto' && cfg.thinkingMode !== 'off') {
    const budgets = { low: 2000, medium: 8000, high: 16000 };
    out.thinking = { type: 'enabled', budget_tokens: budgets[cfg.thinkingMode] };
    // Anthropic Extended Thinking 与 temperature 不兼容
    delete out.temperature;
    if (out.max_tokens < (budgets[cfg.thinkingMode] + 2048)) out.max_tokens = budgets[cfg.thinkingMode] + 4096;
  }
  return out;
}

function parseAnthropicMessage(data) {
  const out = { content: '', tool_calls: [] };
  const blocks = data?.content || [];
  for (const b of blocks) {
    if (b.type === 'text' && b.text) out.content += b.text;
    if (b.type === 'tool_use') {
      out.tool_calls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
    }
  }
  if (!out.tool_calls.length) delete out.tool_calls;
  return out;
}

async function callAnthropic(chatBody, opts = {}) {
  const cfg = getActiveLlmConfig();
  const reqBody = buildAnthropicRequest(chatBody);
  reqBody.stream = true;
  const onProgress = opts.onProgress;
  const t0 = Date.now();
  const entry = {
    at: Date.now(),
    requestPreview: JSON.stringify({
      protocol: 'anthropic',
      model: reqBody.model,
      system: reqBody.system?.slice(0, 240) + (reqBody.system?.length > 240 ? '...' : ''),
      tools: reqBody.tools?.map(t => t.name),
      messages: reqBody.messages?.map(m => {
        if (Array.isArray(m.content)) {
          return { role: m.role, content: m.content.map(b => {
            if (b.type === 'text') return b.text?.slice(0, 200);
            if (b.type === 'image') return '[image]';
            if (b.type === 'tool_use') return `[tool_use ${b.name}]`;
            if (b.type === 'tool_result') return `[tool_result ${b.tool_use_id?.slice(0, 8)}]`;
            return b.type;
          }) };
        }
        return { role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 240) : m.content };
      }),
    }, null, 2),
    elapsedMs: 0,
    httpStatus: 0,
    responseRaw: '',
    rawTruncatedAt: 0,
    parsedPreview: '',
    error: null,
    warn: null,
    summary: '',
  };
  const headers = {
    'Content-Type': 'application/json',
    // Anthropic 标准 header
    'x-api-key': cfg.key,
    'anthropic-version': '2023-06-01',
    // 镜像兼容 OpenAI-style 也透传
    'Authorization': `Bearer ${cfg.key}`,
    'X-LLM-Upstream': cfg.base.replace(/\/$/, ''),
    ...(opts.headers || {}),
  };
  try {
    const r = await fetch('api/llm/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(reqBody),
      signal: opts.signal,
    });
    entry.httpStatus = r.status;
    if (!r.ok) {
      const text = await r.text();
      entry.elapsedMs = Date.now() - t0;
      entry.responseRaw = text.slice(0, 4000);
      entry.rawTruncatedAt = Math.min(text.length, 4000);
      let detail = text;
      try { detail = JSON.parse(text).error?.message || JSON.parse(text).message || detail; } catch {}
      entry.error = `HTTP ${r.status} · ${detail.slice(0, 400)}`;
      entry.summary = `HTTP ${r.status} 失败`;
      throw new Error(entry.error);
    }
    const result = await readAnthropicStream(r, onProgress);
    entry.elapsedMs = Date.now() - t0;
    entry.responseRaw = result.rawSnippet;
    entry.rawTruncatedAt = result.rawSnippet.length;
    entry.summary = `${result.mode} · content=${result.parsed.content?.length || 0}字 · tools=${result.parsed.tool_calls?.length || 0}`;
    entry.parsedPreview = JSON.stringify({
      content: result.parsed.content ? (result.parsed.content.length > 600 ? result.parsed.content.slice(0, 600) + '...' : result.parsed.content) : '',
      tool_calls: result.parsed.tool_calls?.map(tc => ({ id: tc.id, name: tc.function?.name, args: typeof tc.function?.arguments === 'string' ? tc.function.arguments.slice(0, 300) : tc.function?.arguments })),
    }, null, 2);
    if (!result.parsed.content && (!result.parsed.tool_calls || !result.parsed.tool_calls.length)) {
      entry.warn = '解析后内容为空';
      entry.summary = '⚠ ' + entry.summary;
    }
    return result.parsed;
  } catch (err) {
    if (!entry.error) entry.error = err.message;
    if (!entry.summary) entry.summary = '失败';
    throw err;
  } finally {
    pushDebug(entry);
  }
}

async function readAnthropicStream(response, onProgress) {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    let parsed;
    try { parsed = parseAnthropicMessage(JSON.parse(text)); } catch { parsed = { content: '' }; }
    onProgress?.(parsed);
    return { parsed, mode: 'Anthropic 非流式', rawSnippet: text.slice(0, 4000) };
  }
  const decoder = new TextDecoder();
  let buffer = '';
  let rawAll = '';
  const aggregated = { content: '' };
  // Anthropic SSE: 用 event: 标头分别识别 content_block_start/delta/stop
  // block 类型可能是 text 或 tool_use
  const blocks = {}; // index -> { type, name, id, text, partialJson }
  let sawSse = false;

  const snapshot = () => {
    const tool_calls = [];
    let content = '';
    let reasoning = '';
    for (const k of Object.keys(blocks).sort((a, b) => +a - +b)) {
      const blk = blocks[k];
      if (blk.type === 'text') content += blk.text || '';
      else if (blk.type === 'thinking') reasoning += blk.text || '';
      else if (blk.type === 'tool_use') {
        tool_calls.push({ id: blk.id, type: 'function', function: { name: blk.name, arguments: blk.partialJson || '' } });
      }
    }
    aggregated.content = content;
    const out = { content };
    if (reasoning) out.reasoning = reasoning;
    if (tool_calls.length) out.tool_calls = tool_calls;
    return out;
  };
  const emit = () => onProgress?.(snapshot());

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    rawAll += chunk;
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      processBlock(block);
    }
  }
  if (buffer.trim()) processBlock(buffer);

  function processBlock(block) {
    const lines = block.split(/\r?\n/);
    let curEvent = null;
    for (const raw of lines) {
      const line = raw;
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) { curEvent = line.slice(6).trim(); continue; }
      if (!line.startsWith('data:')) continue;
      sawSse = true;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      const ev = obj.type || curEvent;
      if (ev === 'content_block_start') {
        const i = obj.index;
        const cb = obj.content_block || {};
        if (cb.type === 'text') {
          blocks[i] = { type: 'text', text: '' };
        } else if (cb.type === 'thinking') {
          blocks[i] = { type: 'thinking', text: '' };
        } else if (cb.type === 'tool_use') {
          blocks[i] = { type: 'tool_use', id: cb.id, name: cb.name, partialJson: '' };
        }
      } else if (ev === 'content_block_delta') {
        const i = obj.index;
        const d = obj.delta || {};
        if (d.type === 'text_delta' && blocks[i]) blocks[i].text = (blocks[i].text || '') + (d.text || '');
        if (d.type === 'thinking_delta' && blocks[i]) blocks[i].text = (blocks[i].text || '') + (d.thinking || '');
        if (d.type === 'input_json_delta' && blocks[i]) blocks[i].partialJson = (blocks[i].partialJson || '') + (d.partial_json || '');
      } else if (ev === 'content_block_stop') {
        // 完成
      } else if (ev === 'message_stop' || ev === 'message_delta') {
        // 收尾
      }
    }
    emit();
  }
  if (!sawSse) {
    // 非流式
    let parsed;
    try { parsed = parseAnthropicMessage(JSON.parse(rawAll)); } catch { parsed = { content: '' }; }
    onProgress?.(parsed);
    return { parsed, mode: 'Anthropic 非流式', rawSnippet: rawAll.slice(0, 4000) };
  }
  const parsed = snapshot();
  const rawSnippet = rawAll.length > 4000 ? rawAll.slice(0, 4000) + `\n... (共 ${rawAll.length} 字节，已截断)` : rawAll;
  return { parsed, mode: 'Anthropic SSE', rawSnippet };
}

// ============================================================
// Gemini 原生适配器（/v1beta/models/{model}:generateContent）
// ============================================================
function buildGeminiRequest(chatBody) {
  const contents = [];
  let systemText = '';
  for (const m of chatBody.messages || []) {
    if (m.role === 'system') {
      systemText = (systemText ? systemText + '\n\n' : '') + (typeof m.content === 'string' ? m.content : '');
      continue;
    }
    if (m.role === 'user') {
      const parts = [];
      if (typeof m.content === 'string') parts.push({ text: m.content });
      else if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === 'text') parts.push({ text: p.text });
          else if (p.type === 'image_url') {
            const url = p.image_url?.url || p.image_url;
            const dm = /^data:([^;]+);base64,(.+)$/.exec(url || '');
            if (dm) parts.push({ inlineData: { mimeType: dm[1], data: dm[2] } });
          }
        }
      }
      contents.push({ role: 'user', parts });
      continue;
    }
    if (m.role === 'assistant') {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          let args = {};
          try { args = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {}); } catch {}
          parts.push({ functionCall: { name: tc.function?.name, args } });
        }
      }
      contents.push({ role: 'model', parts });
      continue;
    }
    if (m.role === 'tool') {
      let response;
      try { response = JSON.parse(m.content); } catch { response = { result: m.content }; }
      contents.push({ role: 'user', parts: [{ functionResponse: { name: m.name, response } }] });
      continue;
    }
  }
  const functions = (chatBody.tools || []).map(t => {
    if (t.type === 'function' && t.function) {
      return { name: t.function.name, description: t.function.description, parameters: t.function.parameters };
    }
    return t;
  });
  const out = {
    contents,
    system_instruction: systemText ? { parts: [{ text: systemText }] } : undefined,
    generation_config: { temperature: chatBody.temperature },
    tools: functions.length ? [{ function_declarations: functions }] : undefined,
  };
  // 思考预算（Gemini 2.5 thinkingConfig）
  const cfg = getActiveLlmConfig();
  if (cfg.thinkingMode && cfg.thinkingMode !== 'auto') {
    if (cfg.thinkingMode === 'off') {
      out.generation_config.thinking_config = { thinking_budget: 0, include_thoughts: false };
    } else {
      const budgets = { low: 512, medium: 2048, high: 8192 };
      out.generation_config.thinking_config = { thinking_budget: budgets[cfg.thinkingMode], include_thoughts: true };
    }
  }
  return out;
}

function parseGeminiResponse(data) {
  const out = { content: '', tool_calls: [] };
  const candidates = data?.candidates || [];
  for (const c of candidates) {
    const parts = c?.content?.parts || [];
    for (const p of parts) {
      if (typeof p.text === 'string') out.content += p.text;
      if (p.functionCall) {
        out.tool_calls.push({ id: 'gc_' + Math.random().toString(36).slice(2, 10), type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) } });
      }
    }
  }
  if (!out.tool_calls.length) delete out.tool_calls;
  return out;
}

async function callGemini(chatBody, opts = {}) {
  const cfg = getActiveLlmConfig();
  const reqBody = buildGeminiRequest(chatBody);
  const onProgress = opts.onProgress;
  const t0 = Date.now();
  const model = chatBody.model || cfg.model;
  const entry = {
    at: Date.now(),
    requestPreview: JSON.stringify({
      protocol: 'gemini',
      model,
      system_instruction: reqBody.system_instruction?.parts?.[0]?.text?.slice(0, 240),
      tools: reqBody.tools?.[0]?.function_declarations?.map(t => t.name),
      contents: reqBody.contents?.map(c => ({
        role: c.role,
        parts: c.parts?.map(p => p.text ? p.text.slice(0, 240) : (p.inlineData ? '[image]' : (p.functionCall ? `[functionCall ${p.functionCall.name}]` : (p.functionResponse ? `[functionResponse ${p.functionResponse.name}]` : 'unknown')))),
      })),
    }, null, 2),
    elapsedMs: 0,
    httpStatus: 0,
    responseRaw: '',
    rawTruncatedAt: 0,
    parsedPreview: '',
    error: null,
    warn: null,
    summary: '',
  };
  // Gemini 用 streamGenerateContent 流式
  const action = 'streamGenerateContent';
  const path = `api/llm/v1beta/models/${model}:${action}?alt=sse`;
  const headers = {
    'Content-Type': 'application/json',
    'x-goog-api-key': cfg.key,
    'Authorization': `Bearer ${cfg.key}`,
    'X-LLM-Upstream': cfg.base.replace(/\/$/, ''),
    ...(opts.headers || {}),
  };
  try {
    const r = await fetch(path, { method: 'POST', headers, body: JSON.stringify(reqBody), signal: opts.signal });
    entry.httpStatus = r.status;
    if (!r.ok) {
      const text = await r.text();
      entry.elapsedMs = Date.now() - t0;
      entry.responseRaw = text.slice(0, 4000);
      entry.rawTruncatedAt = Math.min(text.length, 4000);
      let detail = text;
      try { detail = JSON.parse(text).error?.message || detail; } catch {}
      entry.error = `HTTP ${r.status} · ${detail.slice(0, 400)}`;
      entry.summary = `HTTP ${r.status} 失败`;
      throw new Error(entry.error);
    }
    const result = await readGeminiStream(r, onProgress);
    entry.elapsedMs = Date.now() - t0;
    entry.responseRaw = result.rawSnippet;
    entry.rawTruncatedAt = result.rawSnippet.length;
    entry.summary = `${result.mode} · content=${result.parsed.content?.length || 0}字 · tools=${result.parsed.tool_calls?.length || 0}`;
    entry.parsedPreview = JSON.stringify({
      content: result.parsed.content ? (result.parsed.content.length > 600 ? result.parsed.content.slice(0, 600) + '...' : result.parsed.content) : '',
      tool_calls: result.parsed.tool_calls?.map(tc => ({ id: tc.id, name: tc.function?.name, args: typeof tc.function?.arguments === 'string' ? tc.function.arguments.slice(0, 300) : tc.function?.arguments })),
    }, null, 2);
    if (!result.parsed.content && (!result.parsed.tool_calls || !result.parsed.tool_calls.length)) {
      entry.warn = '解析后内容为空';
      entry.summary = '⚠ ' + entry.summary;
    }
    return result.parsed;
  } catch (err) {
    if (!entry.error) entry.error = err.message;
    if (!entry.summary) entry.summary = '失败';
    throw err;
  } finally {
    pushDebug(entry);
  }
}

async function readGeminiStream(response, onProgress) {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    let parsed;
    try { parsed = parseGeminiResponse(JSON.parse(text)); } catch { parsed = { content: '' }; }
    onProgress?.(parsed);
    return { parsed, mode: 'Gemini 非流式', rawSnippet: text.slice(0, 4000) };
  }
  const decoder = new TextDecoder();
  let buffer = '';
  let rawAll = '';
  const aggregated = { content: '', reasoning: '', toolByName: {} };
  let sawSse = false;

  const snapshot = () => {
    const tool_calls = [];
    for (const k of Object.keys(aggregated.toolByName)) {
      const t = aggregated.toolByName[k];
      tool_calls.push({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args || {}) } });
    }
    const out = { content: aggregated.content };
    if (aggregated.reasoning) out.reasoning = aggregated.reasoning;
    if (tool_calls.length) out.tool_calls = tool_calls;
    return out;
  };
  const emit = () => onProgress?.(snapshot());

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    rawAll += chunk;
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      processBlock(block);
    }
  }
  if (buffer.trim()) processBlock(buffer);

  function processBlock(block) {
    const lines = block.split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      sawSse = true;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      const candidates = obj?.candidates || [];
      for (const c of candidates) {
        const parts = c?.content?.parts || [];
        for (const p of parts) {
          if (typeof p.text === 'string') {
            if (p.thought) aggregated.reasoning += p.text;
            else aggregated.content += p.text;
          }
          if (p.functionCall) {
            const k = p.functionCall.name + '_' + Object.keys(aggregated.toolByName).length;
            aggregated.toolByName[k] = { id: 'gc_' + Math.random().toString(36).slice(2, 10), name: p.functionCall.name, args: p.functionCall.args || {} };
          }
        }
      }
    }
    emit();
  }
  if (!sawSse) {
    // 可能是 application/json 数组流（旧 streamGenerateContent 不带 alt=sse）
    try {
      const data = JSON.parse(rawAll);
      const parsed = Array.isArray(data) ? data.reduce((acc, d) => {
        const m = parseGeminiResponse(d);
        acc.content = (acc.content || '') + (m.content || '');
        if (m.tool_calls) acc.tool_calls = [...(acc.tool_calls || []), ...m.tool_calls];
        return acc;
      }, { content: '' }) : parseGeminiResponse(data);
      onProgress?.(parsed);
      return { parsed, mode: 'Gemini 非流式', rawSnippet: rawAll.slice(0, 4000) };
    } catch {
      return { parsed: { content: '' }, mode: 'Gemini 解析失败', rawSnippet: rawAll.slice(0, 4000) };
    }
  }
  const parsed = snapshot();
  const rawSnippet = rawAll.length > 4000 ? rawAll.slice(0, 4000) + `\n... (共 ${rawAll.length} 字节，已截断)` : rawAll;
  return { parsed, mode: 'Gemini SSE', rawSnippet };
}

// ============================================================
// 斜杠命令
// ============================================================
const SLASH_COMMANDS = [
  { cmd: '/compress', desc: '让 LLM 把整段对话压缩为一段摘要（替换全部历史，建议先 /export 备份）', run: () => compressHistory() },
  { cmd: '/clear',    desc: '清空当前对话的所有消息（保留对话本身）', run: () => clearCurrentConv() },
  { cmd: '/new',      desc: '新建一个对话', run: () => newConversation() },
  { cmd: '/title',    desc: '重命名当前对话（输入：/title 新名字）', args: true, run: (args) => renameCurrentConv(args) },
  { cmd: '/model',    desc: '切换 LLM 配置（输入：/model 名字片段）', args: true, run: (args) => switchProfile(args) },
  { cmd: '/think',    desc: '临时改思考强度（off / low / medium / high / auto）', args: true, run: (args) => setThinking(args) },
  { cmd: '/persona',  desc: '编辑当前配置的 system prompt', run: () => openPersonaEdit() },
  { cmd: '/window',   desc: '修改上下文窗口（输入：/window 10 / 20 / all）', args: true, run: (args) => setContextWindow(args) },
  { cmd: '/debug',    desc: '展开 / 折叠调试面板', run: () => toggleDebug() },
  { cmd: '/export',   desc: '把当前对话导出为 Markdown 文件', run: () => exportConv() },
  { cmd: '/help',     desc: '显示所有可用命令', run: () => showHelp() },
];

let slashActiveIdx = 0;
let slashFiltered = [];

function renderSlashMenu(query) {
  const menu = $('#slashMenu');
  if (!menu) return;
  if (!query.startsWith('/')) { menu.hidden = true; return; }
  const q = query.slice(1).toLowerCase();
  slashFiltered = SLASH_COMMANDS.filter(c => c.cmd.slice(1).startsWith(q) || c.desc.toLowerCase().includes(q));
  if (!slashFiltered.length) {
    menu.hidden = false;
    menu.innerHTML = '<div class="slash-empty">未找到匹配命令 — 按 Esc 取消</div>';
    return;
  }
  menu.hidden = false;
  slashActiveIdx = Math.min(slashActiveIdx, slashFiltered.length - 1);
  if (slashActiveIdx < 0) slashActiveIdx = 0;
  menu.innerHTML = '';
  slashFiltered.forEach((c, idx) => {
    const item = document.createElement('div');
    item.className = 'slash-item' + (idx === slashActiveIdx ? ' is-active' : '');
    item.innerHTML = `
      <span class="slash-cmd">${escapeHtml(c.cmd)}${c.args ? ' …' : ''}</span>
      <span class="slash-desc">${escapeHtml(c.desc)}</span>
    `;
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      slashActiveIdx = idx;
      acceptSlash();
    });
    menu.appendChild(item);
  });
}

function acceptSlash() {
  const c = slashFiltered[slashActiveIdx];
  if (!c) return;
  const input = $('#chatInput');
  if (c.args) {
    input.value = c.cmd + ' ';
    input.focus();
    renderSlashMenu(input.value);
  } else {
    input.value = c.cmd;
    runSlashCommand(input.value);
    input.value = '';
    closeSlashMenu();
  }
}
function closeSlashMenu() {
  const menu = $('#slashMenu');
  if (menu) menu.hidden = true;
}

function runSlashCommand(text) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1).join(' ').trim();
  const def = SLASH_COMMANDS.find(c => c.cmd === cmd);
  if (!def) { toast('未知命令：' + cmd, 'bad'); return; }
  try { def.run(args); } catch (err) { toast('命令失败：' + err.message, 'bad'); }
}

// ---------- 命令实现 ----------
async function clearCurrentConv() {
  const c = getCurrentConv();
  if (!c) return;
  if (!(await uiConfirm('清空当前对话所有消息？', { okText: '清空', danger: true }))) return;
  c.messages = [];
  c.title = '未命名对话';
  c.updatedAt = Date.now();
  await persistConversations();
  renderConvList();
  renderChat();
  toast('已清空', 'ok');
}

async function renameCurrentConv(name) {
  const c = getCurrentConv();
  if (!c) return;
  name = (name || '').trim() || (await uiPrompt('新标题：', c.title, { title: '重命名对话' }));
  if (!name) return;
  c.title = name;
  c.updatedAt = Date.now();
  await persistConversations();
  renderConvList();
  renderChat();
  toast('已重命名', 'ok');
}

async function switchProfile(query) {
  if (!query) { openDrawer(); return; }
  const q = query.toLowerCase();
  const found = settings.llmProfiles.find(p =>
    (p.name || '').toLowerCase().includes(q) ||
    (p.model || '').toLowerCase().includes(q)
  );
  if (!found) { toast(`没有匹配「${query}」的配置`, 'bad'); return; }
  settings.activeProfileId = found.id;
  await saveSettings();
  renderProfileSelect();
  renderChat();
  toast('已切换到：' + found.name, 'ok');
}

async function setThinking(mode) {
  const p = getActiveProfile();
  if (!p) { toast('未配置任何 profile', 'bad'); return; }
  const valid = ['auto', 'off', 'low', 'medium', 'high'];
  if (!valid.includes(mode)) { toast('无效模式。可选：' + valid.join(' / '), 'bad'); return; }
  p.thinkingMode = mode;
  await saveSettings();
  toast(`「${p.name}」思考强度 → ${mode}`, 'ok');
}

async function setContextWindow(val) {
  const p = getActiveProfile();
  if (!p) { toast('未配置', 'bad'); return; }
  if (val === 'all') p.contextWindow = 'all';
  else {
    const n = parseInt(val, 10);
    if (!n || n < 1) { toast('需要正整数或 all', 'bad'); return; }
    p.contextWindow = n;
  }
  await saveSettings();
  updateContextMeter();
  toast(`上下文窗口 → ${p.contextWindow}`, 'ok');
}

function openPersonaEdit() {
  const p = getActiveProfile();
  if (!p) { toast('未配置', 'bad'); return; }
  openDrawer();
  setTimeout(() => $('#cfgLlmPersona')?.focus(), 100);
}

function toggleDebug() {
  $('#chatDebug').hidden = !$('#chatDebug').hidden;
  $('#chatDebugToggle').classList.toggle('is-on', !$('#chatDebug').hidden);
}

function exportConv() {
  const c = getCurrentConv();
  if (!c) return;
  const lines = [`# ${c.title}`, '', `> 导出于 ${new Date().toLocaleString()}`, ''];
  for (const m of c.messages) {
    if (m.role === 'user') lines.push('## 你', '', m.content || '', '');
    else if (m.role === 'assistant') {
      if (m.reasoning) lines.push('## 助手（思考）', '', '> ' + (m.reasoning || '').split('\n').join('\n> '), '');
      if (m.content) lines.push('## 助手', '', m.content || '', '');
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) lines.push(`### 工具调用 · ${tc.function?.name}`, '', '```json', tc.function?.arguments || '', '```', '');
      }
    } else if (m.role === 'tool') lines.push(`### 工具结果 · ${m.name}`, '', '```json', m.content || '', '```', '');
    else if (m.role === 'system' && m.__summary) lines.push('## [早期摘要]', '', m.content || '', '');
  }
  const md = lines.join('\n');
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${c.title.replace(/[^\w一-龥-]+/g, '_')}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('已导出', 'ok');
}

async function showHelp() {
  const conv = getCurrentConv();
  if (!conv) await ensureConversation();
  const c2 = getCurrentConv();
  const lines = ['以下是所有可用斜杠命令：', ''];
  for (const cmd of SLASH_COMMANDS) {
    lines.push(`- \`${cmd.cmd}\`${cmd.args ? ' <args>' : ''} — ${cmd.desc}`);
  }
  c2.messages.push({
    role: 'assistant',
    content: lines.join('\n'),
    __ts: Date.now(),
  });
  await persistConversations();
  renderChat();
}

// ---------- 历史压缩 ----------
async function compressHistory() {
  const conv = getCurrentConv();
  if (!conv) return;
  if (!llmReady()) { toast('需要先配置 LLM', 'bad'); openDrawer(); return; }
  if (!conv.messages.length) { toast('对话为空，无需压缩', 'bad'); return; }
  if (!(await uiConfirm('确定要压缩当前对话？\n所有原消息会被替换为一段 LLM 生成的摘要，无法撤销（但你可以 /export 先导出备份）。', { title: '压缩对话', okText: '开始压缩' }))) return;

  // 拼接 transcript
  const transcript = conv.messages.map(m => {
    if (m.role === 'system' && m.__summary) return `[之前的摘要]\n${m.content}`;
    if (m.role === 'system') return null;
    if (m.role === 'user') {
      const text = typeof m.content === 'string' ? m.content : '[多模态内容]';
      const atts = m.attachments?.length ? `（附 ${m.attachments.length} 张参考图）` : '';
      return `用户：${text}${atts}`;
    }
    if (m.role === 'assistant') {
      let s = '';
      if (m.reasoning) s += `（思考：${m.reasoning.slice(0, 200)}${m.reasoning.length > 200 ? '…' : ''}）\n`;
      s += `助手：${m.content || ''}`;
      if (m.tool_calls?.length) {
        s += '\n（工具调用：' + m.tool_calls.map(tc => {
          const args = typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {});
          return `${tc.function?.name}(${args.slice(0, 100)}${args.length > 100 ? '…' : ''})`;
        }).join('; ') + '）';
      }
      return s;
    }
    if (m.role === 'tool') {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `工具结果（${m.name}）：${content.slice(0, 200)}${content.length > 200 ? '…' : ''}`;
    }
    return null;
  }).filter(Boolean).join('\n\n');
  if (!transcript) { toast('没有可压缩内容', 'bad'); return; }

  const origCount = conv.messages.length;

  // 流式输出：先把现有消息隐藏在 backup 里，临时只显示一个 streaming 摘要消息
  const backup = conv.messages.slice();
  const streamingMsg = {
    role: 'system',
    content: '',
    __summary: true,
    __streaming: true,
    __ts: Date.now(),
  };
  conv.messages = [streamingMsg];
  renderChat();

  try {
    const abort = new AbortController();
    chatAbort = abort;
    chatBusy = true;
    setChatBusy(true);
    const result = await callLlmChat({
      model: getActiveLlmConfig().model,
      messages: [
        { role: 'system', content: '把以下对话压缩成一段简洁的中文摘要，500 字以内。保留：\n- 用户原始需求与意图\n- 已确定的关键参数与决策\n- 已生成作品的任务编号（№xxx）与类型\n- 工具调用要点与结果\n- 当前待办或上下文\n直接输出摘要，不要前言/标题/列表符号。' },
        { role: 'user', content: transcript },
      ],
      temperature: 0.3,
      tools: undefined,
    }, {
      signal: abort.signal,
      onProgress: (partial) => {
        streamingMsg.content = partial.content || '';
        renderChat();
      },
    });
    const summary = (result?.content || streamingMsg.content || '').trim();
    if (!summary) {
      conv.messages = backup;
      renderChat();
      toast('LLM 返回为空，压缩失败', 'bad');
      return;
    }
    streamingMsg.content = summary;
    streamingMsg.__streaming = false;
    conv.updatedAt = Date.now();
    await persistConversations();
    renderChat();
    toast(`已压缩 ${origCount} → 1 条摘要（${summary.length} 字）`, 'ok');
  } catch (err) {
    if (err.name === 'AbortError') {
      conv.messages = backup;
      renderChat();
      toast('已中断压缩，恢复原对话', 'ok');
    } else {
      conv.messages = backup;
      renderChat();
      toast('压缩失败：' + err.message, 'bad');
    }
  } finally {
    chatBusy = false;
    chatAbort = null;
    setChatBusy(false);
  }
}

const SYSTEM_PROMPT = `你是「造影工作台」的对话助手，能调用工具帮用户生成视频和图像。

## 可用工具（共 8 个）

### 图像生成（二选一）
1. **generate_image_openai** — OpenAI gpt-image-2
   - 优势：任意自定义尺寸（如 1024x1024 / 1536x1024 / 2048x2048 / 3840x2160）、三档画质（low/medium/high）、**支持单次 1-6 张（n 参数）**
   - 模式：text_to_image（纯文生图，可加参考图作风格参考）或 image_edit（必须有底图，对底图做修改）
   - 用户说"给我 4 张" / "出 6 张变体"时直接 n=4 或 6，单次返回多张，比并行更高效
2. **generate_image_gemini** — Gemini nanobananapro / nanobanana2
   - 优势：丰富的比例支持（21:9 ~ 9:16 共 10 种；nanobanana2 多 8:1/4:1/1:4/1:8 共 14 种），三档分辨率（1K/2K/4K）
   - 用于：海报、极端宽幅条幅、社媒尺寸（1:1 / 9:16）等场景

### 视频生成（二选一）
3. **generate_video_sora** — Sora V3（fast / pro，5-15 秒任意）
4. **generate_video_veo** — Veo 3.1（fast / std / ref，固定 4/6/8 秒，可生成音频，ref 变体保证主体一致）

### 图像迭代（最常用！）
5. **edit_image** — 对已生成的图片做修改。指定任务号 folio + 编辑指令即可。
   - 用户说"这张图改成夜晚 / 加点雪 / 换背景"等都用它
   - 可链式：每次基于上一轮新生成的 №xxx 继续编辑
   - 不知道 folio 时先调 list_recent_works

### 辅助工具
6. **describe_reference_image** — 用 vision 看用户附的参考图，输出 prompt 供后续使用
7. **list_recent_works** — 看用户最近作品（含 folio 任务号）。**当用户说"刚才那张/上面那张/最新的图"时必须先调这个查清 folio**
8. **set_compose_form** — 把讨论的参数填回 GUI 表单供手动微调

## 准则

- 用户给中文需求时先复述一句你的理解，再用**地道英文**作为 prompt 调用工具
- prompt 要**具体**：主体 + 动作/构图 + 镜头/视角 + 布光 + 风格 + 色彩 + 情绪
- **修改已有图像**用 edit_image，不要 generate_image_openai 重做（这样保持基础构图）
- 用户要"多个变体"时**同一轮调用多次**对应工具，每次参数不同
- **工具失败时继续尝试**：换参数 / 换工具 / 简化 prompt 再试，或者先解释原因再换方式。不要因一次失败就停下让用户重新发起 — 除非用户明确要求停止
- 默认偏好：
  - 草稿/快速：image_openai gpt-image-2 + low + 1024x1024；video_sora jimeng-v3-fast 7s 1280x720
  - 终稿/精细：image_openai high；video_sora jimeng-v3-pro 或 video_veo std
  - 极端比例（如 8:1 横幅 / 9:16 竖版海报）：image_gemini
  - 带音频或主体一致：video_veo
- 回复用中文，简洁不啰嗦，不要把内部 ID 暴露给用户`;

const VEO_SIZES = ['1280x720', '720x1280', '1920x1080', '1080x1920'];
const SORA_SIZES = ['1280x720', '720x1280', '1920x1080', '1080x1920', '1792x1024', '1024x1792'];
const GEMINI_ASPECTS_PRO = ['21:9','16:9','3:2','4:3','5:4','1:1','4:5','3:4','2:3','9:16'];
const GEMINI_ASPECTS_2   = [...GEMINI_ASPECTS_PRO, '8:1','4:1','1:4','1:8'];

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'generate_image_openai',
      description: '使用 OpenAI gpt-image-2 生成一张图像。任意尺寸 + 三档画质。适合一般图像生成、海报、产品图、需要精确像素尺寸的场景。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '英文提示词，含主体、构图、风格、布光、色彩' },
          mode:   { type: 'string', enum: ['text_to_image', 'image_edit'], description: 'text_to_image=纯文生图（可附参考图作风格参考）；image_edit=必须用附图作底图做修改' },
          size:   { type: 'string', description: 'W x H 像素，例 1024x1024 / 1536x1024 / 1024x1792 / 2048x2048 / 3840x2160（小写 x）' },
          quality:{ type: 'string', enum: ['low', 'medium', 'high'], description: 'low=快 medium=中 high=精细，价格依次递增' },
          n:      { type: 'integer', description: '一次生成几张（1-6）。同 prompt 多变体场景用' },
          use_attached_refs: { type: 'boolean', description: '是否使用用户附在输入框的参考图。image_edit 时必须 true（除非用 ref_folios）' },
          ref_folios: { type: 'array', items: { type: 'integer' }, description: '从已生成作品里挑参考图，传它们的任务号 folio（例如 [5, 7]）。image_edit 时第一个 folio 是底图，其余是参考' },
        },
        required: ['prompt', 'mode', 'size', 'quality', 'n', 'use_attached_refs', 'ref_folios'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image_gemini',
      description: '使用 Gemini nanobananapro / nanobanana2 生成图像。优势：丰富画幅比例（含极端比例 8:1 / 1:8）和 1K/2K/4K 分辨率档位。适合海报、宽幅条幅、社媒竖版等。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          model:  { type: 'string', enum: ['nanobananapro', 'nanobanana2'], description: 'nanobananapro 稳定版（10 种比例）；nanobanana2 增强版（多支持 8:1 / 4:1 / 1:4 / 1:8 四种极端比例，共 14 种）' },
          aspect_ratio: { type: 'string', enum: GEMINI_ASPECTS_2, description: 'nanobananapro 仅支持前 10 个（21:9 ~ 9:16）；nanobanana2 全部 14 个' },
          image_size: { type: 'string', enum: ['1K', '2K', '4K'], description: '分辨率档位。4K 耗时显著长' },
          use_attached_refs: { type: 'boolean', description: '是否使用用户附在输入框的参考图' },
          ref_folios: { type: 'array', items: { type: 'integer' }, description: '从已生成作品里挑参考图，传它们的任务号 folio（例如 [5, 7]）' },
        },
        required: ['prompt', 'model', 'aspect_ratio', 'image_size', 'use_attached_refs', 'ref_folios'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_video_sora',
      description: '使用 Sora V3 生成视频。时长任意 5-15 秒，可自定义尺寸（含影院比 1792x1024）。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '英文提示词，明确镜头运动 / 主体动作 / 布光 / 风格' },
          model: { type: 'string', enum: ['jimeng-v3-fast', 'jimeng-v3-pro'], description: 'fast=速度优先（草稿）；pro=质量优先（终稿）' },
          seconds: { type: 'integer', minimum: 5, maximum: 15, description: '时长（秒），5–15 之间整数' },
          size: { type: 'string', enum: SORA_SIZES, description: '1280x720 / 720x1280 / 1920x1080 / 1080x1920 / 1792x1024 / 1024x1792' },
          use_attached_refs: { type: 'boolean', description: '是否使用附图。最多 4 张：images[0]=首帧，images[1]=尾帧，其余=参考图' },
        },
        required: ['prompt', 'model', 'seconds', 'size', 'use_attached_refs'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_video_veo',
      description: '使用 Veo 3.1 生成视频。三种变体（fast/std/ref），固定时长 4/6/8 秒。优势：可生成音频，可加负面提示词。ref 变体保证多镜头主体一致。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          variant: { type: 'string', enum: ['fast', 'std', 'ref'], description: 'fast=速度优先；std=标准；ref=参考图主体一致性（必须配合 use_attached_refs=true，最多 3 张）' },
          seconds: { type: 'integer', enum: [4, 6, 8], description: '固定 4 / 6 / 8 秒（Veo 时长在模型名里）' },
          size: { type: 'string', enum: VEO_SIZES },
          generate_audio: { type: 'boolean', description: '是否生成音频（对话/背景音）' },
          negative_prompt: { type: 'string', description: '负面提示词，留空字符串即可' },
          use_attached_refs: { type: 'boolean', description: '是否用附图。fast/std 最多 2 张；ref 最多 3 张' },
        },
        required: ['prompt', 'variant', 'seconds', 'size', 'generate_audio', 'negative_prompt', 'use_attached_refs'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_image',
      description: '对已生成的图片做修改（image edit）。指定任务号 base_folio 作为底图（必填），可选 ref_folios 作为额外参考图，prompt 描述要怎么改。常用于：换背景、加元素、改风格、改光线。可多轮迭代（每次基于上一轮 №xxx 继续编辑）。',
      parameters: {
        type: 'object',
        properties: {
          base_folio: { type: 'integer', description: '底图任务号 folio。要编辑刚才那张就用最近的 №xxx 数字' },
          ref_folios: { type: 'array', items: { type: 'integer' }, description: '可选额外参考图任务号（例 [3, 7]）；不需要传空数组 []' },
          prompt:     { type: 'string',  description: '英文修改指令，例：Replace the background with a starry night sky / Add a small glowing moon top-right / Make it look like a riso print' },
          size:       { type: 'string',  description: 'W x H 像素，常用 1024x1024 / 1536x1024' },
          quality:    { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['base_folio', 'ref_folios', 'prompt', 'size', 'quality'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'describe_reference_image',
      description: '当用户附了参考图但你不确定怎么描述时，让 vision 模型看图写一段英文 prompt 作为后续工具调用的起点。',
      parameters: {
        type: 'object',
        properties: {
          attachment_index: { type: 'integer', description: '附件下标（从 0 开始）' },
        },
        required: ['attachment_index'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_recent_works',
      description: '列出用户最近的几个作品（带任务号、提示词、状态）。用于"再做一张类似的"等场景。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '返回多少条，建议 6' },
        },
        required: ['limit'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_compose_form',
      description: '把当前讨论的参数填回构图表单，方便用户在 GUI 上手动调整。不会自动提交。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['image', 'video'] },
          prompt: { type: 'string' },
        },
        required: ['kind', 'prompt'],
      },
    },
  },
];

// ---------- 会话与消息状态 ----------
let conversations = [];       // [{ id, title, messages: [...], createdAt, updatedAt }]
let currentConvId = null;
let chatAttachments = [];     // 当前正在编辑的输入框附件

async function loadConversations() {
  conversations = (await KV.get('conversations', [])) || [];
  if (!Array.isArray(conversations)) conversations = [];
  currentConvId = (await KV.get('current_conv', null)) || null;
  if (!conversations.find(c => c.id === currentConvId)) {
    currentConvId = conversations[0]?.id || null;
  }
}
async function persistConversations() {
  await KV.put('conversations', conversations);
  await KV.put('current_conv', currentConvId);
}
function getCurrentConv() {
  return conversations.find(c => c.id === currentConvId);
}
async function newConversation() {
  const c = {
    id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    title: '未命名对话',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  conversations.unshift(c);
  currentConvId = c.id;
  await persistConversations();
  renderConvList();
  renderChat();
  return c;
}
async function ensureConversation() {
  if (!getCurrentConv()) await newConversation();
}
async function deleteConversation(id) {
  conversations = conversations.filter(c => c.id !== id);
  if (currentConvId === id) currentConvId = conversations[0]?.id || null;
  await persistConversations();
  renderConvList();
  renderChat();
}
async function renameConversation(id, name) {
  const c = conversations.find(x => x.id === id);
  if (!c) return;
  c.title = name;
  c.updatedAt = Date.now();
  await persistConversations();
  renderConvList();
  renderChat();
}

function renderConvList() {
  const root = $('#chatList');
  if (!root) return;
  root.innerHTML = '';
  for (const c of conversations) {
    const li = document.createElement('li');
    li.className = 'chat-item' + (c.id === currentConvId ? ' is-active' : '');
    const d = new Date(c.updatedAt || c.createdAt);
    li.innerHTML = `
      <span class="chat-item-title">${escapeHtml(c.title)}</span>
      <span class="chat-item-time">${String(d.getMonth() + 1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}</span>
    `;
    li.addEventListener('click', () => switchConversation(c.id));
    root.appendChild(li);
  }
  $('#navChatCount').textContent = conversations.length;
}
async function switchConversation(id) {
  currentConvId = id;
  await KV.put('current_conv', currentConvId);
  renderConvList();
  renderChat();
}

// ---------- 消息渲染 ----------
function renderChat() {
  const c = getCurrentConv();
  const titleEl = $('#chatTitle');
  if (titleEl) titleEl.textContent = c ? c.title : '未命名对话';
  renderChatProfileSelect();

  const stream = $('#chatStream');
  if (!stream) return;
  stream.innerHTML = '';

  if (!llmReady()) {
    const warn = document.createElement('div');
    warn.className = 'chat-warn';
    warn.innerHTML = '请先在右上角「密钥」中配置并启用 <strong>提示词增强 LLM</strong>，对话功能需要它来调度工具。建议使用支持 function calling 的模型（GPT-4o-mini、Claude Sonnet、Gemini Flash 等）。';
    stream.appendChild(warn);
  }

  if (!c || !c.messages.length) {
    const empty = document.createElement('div');
    empty.className = 'chat-empty';
    empty.innerHTML = '说出你想要什么。<br>例如「做一张冬日图书馆海报」「这张图改成夜晚」「给我 4 个风格变体对比」';
    stream.appendChild(empty);
    return;
  }

  for (let i = 0; i < c.messages.length; i++) {
    const m = c.messages[i];
    if (m.role === 'system' && m.__summary) {
      const sum = document.createElement('details');
      sum.className = 'msg-summary' + (m.__streaming ? ' is-streaming' : '');
      sum.open = !!m.__streaming;
      const charCount = (m.content || '').length;
      const summary = document.createElement('summary');
      summary.className = 'msg-summary-head';
      summary.innerHTML = `
        <span class="msg-summary-icon">⌧</span>
        <span class="msg-summary-label">${m.__streaming ? '正在压缩…' : '上下文摘要'}</span>
        <span class="msg-summary-count">${charCount} 字${m.__streaming ? '<span class="stream-cursor"></span>' : ''}</span>
        <span class="msg-summary-toggle">▾</span>
      `;
      sum.appendChild(summary);
      const body = document.createElement('div');
      body.className = 'msg-summary-body';
      body.innerHTML = renderMarkdown(m.content || '');
      sum.appendChild(body);
      stream.appendChild(sum);
      continue;
    }
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      stream.appendChild(renderUserMsg(m, i));
    } else if (m.role === 'assistant') {
      if (m.reasoning) {
        stream.appendChild(renderReasoning(m.reasoning, m.__streaming));
      }
      if (m.content) {
        stream.appendChild(renderAssistantText(m.content, i, m.__streaming));
      } else if (m.__streaming) {
        stream.appendChild(renderAssistantThinking());
      } else if (!m.tool_calls || !m.tool_calls.length) {
        if (m.reasoning) {
          // 已经有 reasoning 渲染了，不再渲染空消息
        } else {
          stream.appendChild(renderAssistantEmpty(i));
        }
      }
      if (m.__aborted) {
        const aborted = document.createElement('div');
        aborted.className = 'msg-aborted';
        aborted.textContent = '— 用户中断 —';
        stream.appendChild(aborted);
      }
      if (m.tool_calls) {
        for (const tc of m.tool_calls) stream.appendChild(renderToolCallCard(tc, m, i));
      }
    } else if (m.role === 'tool') {
      // tool 结果由上面的 tool_call 卡片渲染，跳过
    }
  }
  stream.scrollTop = stream.scrollHeight;
  updateContextMeter();
}

function renderUserMsg(m, idx) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-user';
  wrap.innerHTML = `
    <div class="msg-row">
      <span class="msg-role">你</span>
      <span class="msg-tools">
        <button type="button" class="msg-action" data-act="edit" title="编辑消息（会清除其后的回复）">编辑</button>
        <button type="button" class="msg-action" data-act="resend" title="不修改直接重发">重发</button>
        <button type="button" class="msg-action" data-act="copy" title="复制原文">复制</button>
      </span>
    </div>
    <div class="msg-body">${escapeHtml(m.content || '')}</div>
  `;
  if (m.attachments && m.attachments.length) {
    const at = document.createElement('div');
    at.className = 'msg-attach';
    for (const a of m.attachments) {
      const img = document.createElement('img');
      img.src = a.src;
      at.appendChild(img);
    }
    wrap.appendChild(at);
  }
  wrap.querySelector('[data-act="edit"]').addEventListener('click', () => editUserMessage(idx));
  wrap.querySelector('[data-act="resend"]').addEventListener('click', () => resendFromUser(idx));
  wrap.querySelector('[data-act="copy"]').addEventListener('click', () => copyText(m.content || ''));
  return wrap;
}
function renderAssistantText(text, msgIdx, isStreaming) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-assistant';
  const cursor = isStreaming ? '<span class="stream-cursor"></span>' : '';
  const mdHtml = renderMarkdown(text);
  wrap.innerHTML = `
    <div class="msg-row">
      <span class="msg-role">助手${isStreaming ? ' <span class="stream-tag">流式</span>' : ''}</span>
      <span class="msg-tools">
        ${isStreaming ? '' : '<button type="button" class="msg-action" data-act="retry" title="对该轮重新生成">↺ 重试</button>'}
        <button type="button" class="msg-action" data-act="copy" title="复制原始文本">复制</button>
      </span>
    </div>
    <div class="msg-body md-content">${mdHtml}${cursor}</div>
  `;
  if (typeof msgIdx === 'number' && !isStreaming) {
    wrap.querySelector('[data-act="retry"]')?.addEventListener('click', () => retryAssistant(msgIdx));
  }
  wrap.querySelector('[data-act="copy"]').addEventListener('click', () => copyText(text));
  return wrap;
}

function renderAssistantThinking() {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-assistant';
  wrap.innerHTML = `
    <div class="msg-row">
      <span class="msg-role">助手 <span class="stream-tag">思考中</span></span>
    </div>
    <div class="msg-thinking">
      <span class="msg-thinking-dot"></span>
      <span class="msg-thinking-dot"></span>
      <span class="msg-thinking-dot"></span>
    </div>
  `;
  return wrap;
}

function renderReasoning(text, isStreaming) {
  const wrap = document.createElement('details');
  wrap.className = 'msg msg-reasoning' + (isStreaming ? ' is-streaming' : '');
  wrap.open = !!isStreaming;
  const chars = text.length;
  const head = document.createElement('summary');
  head.className = 'reasoning-head';
  head.innerHTML = `
    <span class="reasoning-icon">⌬</span>
    <span class="reasoning-title">${isStreaming ? '正在思考…' : '已思考'}</span>
    <span class="reasoning-meta">${chars} 字${isStreaming ? '<span class="stream-cursor"></span>' : ''}</span>
    <span class="reasoning-toggle">▾</span>
  `;
  wrap.appendChild(head);
  const body = document.createElement('div');
  body.className = 'reasoning-body md-content';
  body.innerHTML = renderMarkdown(text);
  wrap.appendChild(body);
  return wrap;
}

function renderAssistantEmpty(msgIdx) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-assistant';
  // 看最近一条调试条目是否有诊断
  const recentDiag = llmDebugLog[0]?.diagnostic;
  const noteHtml = recentDiag
    ? `<div class="msg-empty-note"><strong>${escapeHtml(recentDiag.title)}</strong><br><span class="msg-empty-sub">${escapeHtml(recentDiag.detail)}</span></div>`
    : `<div class="msg-empty-note">（助手没有返回任何内容。点右上「调试 ▾」展开看 LLM 实际返回了什么。）</div>`;
  wrap.innerHTML = `
    <div class="msg-row">
      <span class="msg-role">助手</span>
      <span class="msg-tools">
        <button type="button" class="msg-action" data-act="open-keys">换模型</button>
        <button type="button" class="msg-action" data-act="retry">↺ 重试</button>
        <button type="button" class="msg-action" data-act="debug">查看响应</button>
      </span>
    </div>
    ${noteHtml}
  `;
  wrap.querySelector('[data-act="retry"]').addEventListener('click', () => retryAssistant(msgIdx));
  wrap.querySelector('[data-act="debug"]').addEventListener('click', () => {
    $('#chatDebug').hidden = false;
    $('#chatDebugToggle').classList.add('is-on');
    renderDebugPanel();
  });
  wrap.querySelector('[data-act="open-keys"]').addEventListener('click', openDrawer);
  return wrap;
}
function renderToolCallCard(tc, assistantMsg) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-assistant';
  const tool = document.createElement('div');
  tool.className = 'msg-tool';
  const status = tc.__status || 'done';
  const statusText = { streaming: '生成参数中…', running: '执行中…', done: '完成', failed: '失败' }[status] || status;
  const statusCls  = { streaming: 'is-streaming', running: 'is-running', done: 'is-done', failed: 'is-failed' }[status] || '';
  const fnName = tc.function?.name || 'unknown';
  let argsDisplay = '';
  const rawArgs = tc.function?.arguments;
  if (typeof rawArgs === 'string') {
    try {
      argsDisplay = JSON.stringify(JSON.parse(rawArgs), null, 2);
    } catch {
      // 参数还在流式生成中，展示原始 partial
      argsDisplay = rawArgs;
    }
  } else if (rawArgs && typeof rawArgs === 'object') {
    argsDisplay = JSON.stringify(rawArgs, null, 2);
  }
  tool.innerHTML = `
    <div class="msg-tool-head">
      <span class="msg-tool-icon">⚒</span>
      <span class="msg-tool-name">${escapeHtml(fnName)}</span>
      <span class="msg-tool-status ${statusCls}">${statusText}</span>
    </div>
    <div class="msg-tool-args">${escapeHtml(argsDisplay)}${status === 'streaming' ? '<span class="stream-cursor"></span>' : ''}</div>
  `;
  // 工具结果展示
  const results = (tc.__results || []);
  if (results.length) {
    const grid = document.createElement('div');
    grid.className = 'msg-tool-result';
    for (const r of results) {
      const card = document.createElement('div');
      card.className = 'msg-tool-card';
      const media = document.createElement('div');
      media.className = 'msg-tool-media';
      const task = tasks.find(t => t.localId === r.taskLocalId);
      if (task && task.status === 'completed' && task.kind === 'image' && (task.imageDataUrl || task.imageUrl)) {
        const img = document.createElement('img');
        img.src = task.imageDataUrl || task.imageUrl;
        media.appendChild(img);
      } else if (task && task.kind === 'video' && task.taskId && task.status === 'completed') {
        const v = document.createElement('video');
        setVideoSource(v, task);
        v.muted = true; v.playsInline = true; v.preload = 'metadata';
        v.addEventListener('mouseenter', () => v.play().catch(() => {}));
        v.addEventListener('mouseleave', () => { v.pause(); v.currentTime = 0; });
        media.appendChild(v);
      } else if (task) {
        const p = document.createElement('div');
        p.className = 'recent-pending';
        const stxt = STATUS_TEXT[task.status] || task.status;
        const prog = task.progress ? ` · ${task.progress}%` : '';
        p.innerHTML = `<span class="dot"></span><span>${stxt}${prog}</span>`;
        media.appendChild(p);
      } else if (r.summary) {
        const p = document.createElement('div');
        p.className = 'recent-pending';
        p.innerHTML = `<span>${escapeHtml(r.summary)}</span>`;
        media.appendChild(p);
      }
      const cap = document.createElement('div');
      cap.className = 'msg-tool-card-cap';
      cap.textContent = task ? `№${pad3(task.folio)} · ${task.model}` : (r.label || '');
      card.appendChild(media);
      card.appendChild(cap);
      if (task) card.addEventListener('click', () => openModal(task));
      grid.appendChild(card);
    }
    tool.appendChild(grid);
  } else if (status === 'running') {
    const sh = document.createElement('div');
    sh.className = 'tool-shimmer';
    tool.appendChild(sh);
  } else if (tc.__textResult) {
    const tr = document.createElement('div');
    tr.className = 'msg-tool-args';
    tr.style.maxHeight = '180px';
    tr.textContent = tc.__textResult;
    tool.appendChild(tr);
  }
  wrap.appendChild(tool);
  return wrap;
}

// ---------- 消息操作：重试 / 编辑 / 复制 ----------
async function copyText(s) {
  try {
    await navigator.clipboard.writeText(s);
    toast('已复制', 'ok');
  } catch {
    toast('复制失败', 'bad');
  }
}

async function editUserMessage(idx) {
  const conv = getCurrentConv();
  if (!conv) return;
  const m = conv.messages[idx];
  if (!m || m.role !== 'user') return;
  const next = await uiPrompt('编辑消息（保存后会清掉它之后的所有回复并重新发送）：', m.content || '', { title: '编辑消息' });
  if (next == null) return;
  const trimmed = next.trim();
  if (!trimmed) return;
  m.content = trimmed;
  // 清除该 user 消息之后的所有消息
  conv.messages.length = idx + 1;
  conv.updatedAt = Date.now();
  await persistConversations();
  renderChat();
  runAgentLoop();
}

async function resendFromUser(idx) {
  const conv = getCurrentConv();
  if (!conv) return;
  const m = conv.messages[idx];
  if (!m || m.role !== 'user') return;
  if (!(await uiConfirm('重发这条消息？将丢弃它之后的所有回复。', { okText: '重发' }))) return;
  conv.messages.length = idx + 1;
  conv.updatedAt = Date.now();
  await persistConversations();
  renderChat();
  runAgentLoop();
}

async function retryAssistant(idx) {
  const conv = getCurrentConv();
  if (!conv) return;
  // 找到这条 assistant 消息之前的最后一条 user 消息
  let userIdx = idx - 1;
  while (userIdx >= 0 && conv.messages[userIdx].role !== 'user') userIdx--;
  if (userIdx < 0) { toast('找不到前置用户消息', 'bad'); return; }
  if (!(await uiConfirm('对这一轮重新生成？将丢弃当前回复及之后的工具结果。', { okText: '重新生成' }))) return;
  conv.messages.length = userIdx + 1;
  conv.updatedAt = Date.now();
  await persistConversations();
  renderChat();
  runAgentLoop();
}

// 把 agent 主循环从 sendChatMessage 拆出来，方便重试时复用
async function runAgentLoop() {
  if (chatBusy) { toast('上一条还没完成', 'bad'); return; }
  if (!llmReady()) {
    toast('请先在「密钥」配置并启用 LLM', 'bad');
    openDrawer();
    return;
  }
  const conv = getCurrentConv();
  if (!conv) return;
  // 找最后一条 user 消息的附件（用于本轮工具调用）
  let userAttachments = [];
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    if (conv.messages[i].role === 'user') {
      userAttachments = conv.messages[i].attachments || [];
      break;
    }
  }

  chatBusy = true;
  chatAbort = new AbortController();
  setChatBusy(true);
  try {
    let rounds = 0;
    while (rounds < MAX_TOOL_ROUNDS) {
      if (chatAbort.signal.aborted) break;
      rounds++;
      const apiMessages = buildApiMessages(conv);
      const body = {
        model: getActiveLlmConfig().model,
        messages: apiMessages,
        tools: TOOLS,
        tool_choice: 'auto',
        temperature: 0.6,
      };
      // 先 push 一个空的 assistant 占位 — 流式时实时更新它
      const streamingMsg = {
        role: 'assistant',
        content: '',
        reasoning: '',
        tool_calls: undefined,
        __ts: Date.now(),
        __streaming: true,
      };
      conv.messages.push(streamingMsg);
      renderChat();
      let aiMsg;
      try {
        aiMsg = await callLlmChat(body, {
          signal: chatAbort.signal,
          onProgress: (partial) => {
            streamingMsg.content = partial.content || '';
            streamingMsg.reasoning = partial.reasoning || '';
            if (partial.tool_calls) {
              streamingMsg.tool_calls = partial.tool_calls.map(tc => ({
                id: tc.id,
                type: tc.type,
                function: { name: tc.function?.name, arguments: tc.function?.arguments },
                __status: 'streaming',
              }));
            }
            renderChat();
          },
        });
      } catch (err) {
        if (err.name === 'AbortError' || /aborted|abort/i.test(err.message || '')) {
          streamingMsg.__streaming = false;
          streamingMsg.__aborted = true;
          renderChat();
          break;
        }
        throw err;
      }
      // 流完成
      streamingMsg.content = aiMsg.content || streamingMsg.content;
      streamingMsg.reasoning = aiMsg.reasoning || streamingMsg.reasoning || '';
      streamingMsg.__streaming = false;
      if (aiMsg.tool_calls && aiMsg.tool_calls.length) {
        streamingMsg.tool_calls = aiMsg.tool_calls.map(tc => ({
          id: tc.id,
          type: tc.type,
          function: { name: tc.function.name, arguments: tc.function.arguments },
        }));
      } else {
        streamingMsg.tool_calls = undefined;
      }
      const newAssistantMsg = streamingMsg;
      if (!newAssistantMsg.tool_calls || !newAssistantMsg.tool_calls.length) break;
      renderChat();
      for (const tc of newAssistantMsg.tool_calls) {
        if (chatAbort?.signal.aborted) break;
        tc.__status = 'running';
        tc.__results = [];
        renderChat();
        try {
          const ret = await executeToolCall(tc, userAttachments);
          tc.__status = 'done';
          if (Array.isArray(ret.taskLocalIds) && ret.taskLocalIds.length) {
            tc.__results = ret.taskLocalIds.map(id => ({ taskLocalId: id }));
          } else if (ret.taskLocalId) {
            tc.__results = [{ taskLocalId: ret.taskLocalId, label: ret.summary || '' }];
          }
          if (ret.text) tc.__textResult = ret.text;
          // 给 LLM 回报：多张时给 folio 列表
          let toolReplyFolios;
          if (Array.isArray(ret.taskLocalIds)) {
            toolReplyFolios = ret.taskLocalIds.map(id => tasks.find(t => t.localId === id)?.folio).filter(Boolean);
          } else if (ret.taskLocalId) {
            const f = tasks.find(t => t.localId === ret.taskLocalId)?.folio;
            if (f) toolReplyFolios = [f];
          }
          conv.messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: JSON.stringify({
              ok: true,
              summary: ret.summary || ret.text || 'done',
              taskFolios: toolReplyFolios,
            }),
            __ts: Date.now(),
          });
        } catch (err) {
          tc.__status = 'failed';
          tc.__textResult = err.message;
          conv.messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: JSON.stringify({ ok: false, error: err.message }),
            __ts: Date.now(),
          });
        }
        renderChat();
      }
      conv.updatedAt = Date.now();
      await persistConversations();
    }
    if (rounds >= MAX_TOOL_ROUNDS) {
      conv.messages.push({ role: 'assistant', content: '（已达本轮工具调用上限，已停止。）' });
    }
    await persistConversations();
    renderChat();
  } catch (err) {
    if (err.name === 'AbortError' || /aborted|abort/i.test(err.message || '')) {
      // 用户主动中断，不再 push 错误消息
    } else {
      conv.messages.push({ role: 'assistant', content: '出错了：' + err.message });
      await persistConversations();
      renderChat();
      toast('对话失败：' + err.message, 'bad');
    }
  } finally {
    chatBusy = false;
    chatAbort = null;
    setChatBusy(false);
  }
}

// ---------- 工具执行器 ----------
async function executeToolCall(tc, userAttachments) {
  const name = tc.function?.name;
  let args = {};
  try { args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function.arguments || {}); } catch {}

  // ---- helper: 从作品 folio 列表转换为 ref 数组 ----
  // 策略：优先 imageDataUrl（base64，永久可用）→ 尝试 fetch imageUrl 缓存 → 直接给上游 URL 让它自己拉
  async function refsFromFolios(folios) {
    const out = [];
    for (const folio of (folios || [])) {
      const t = tasks.find(x => x.folio === folio && x.kind === 'image' && x.status === 'completed');
      if (!t) {
        throw new Error(`找不到已完成的图像作品 №${pad3(folio)}`);
      }
      // 1) 已缓存的 base64
      if (t.imageDataUrl) {
        out.push({ kind: 'data', src: t.imageDataUrl });
        continue;
      }
      // 2) 尝试 fetch 外链转 base64（同步等待，缓存住）
      if (t.imageUrl) {
        try {
          const r = await fetch(t.imageUrl);
          if (r.ok) {
            const blob = await r.blob();
            const dataUrl = await new Promise((res, rej) => {
              const rd = new FileReader();
              rd.onload = () => res(rd.result);
              rd.onerror = rej;
              rd.readAsDataURL(blob);
            });
            t.imageDataUrl = dataUrl;
            await persistTask(t);
            out.push({ kind: 'data', src: dataUrl });
            continue;
          }
        } catch {}
        // 3) 兜底：直接传 URL 给上游让它拉（OpenAI gpt-image-2 接受 URL）
        out.push({ kind: 'url', src: t.imageUrl });
        continue;
      }
      throw new Error(`№${pad3(folio)} 既无本地缓存也无外链`);
    }
    return out;
  }

  // ---- 选择参考图：优先 ref_folios，其次 use_attached_refs；都允许混用 ----
  async function gatherRefs(maxCount = 6) {
    let collected = [];
    if (Array.isArray(args.ref_folios) && args.ref_folios.length) {
      collected = collected.concat(await refsFromFolios(args.ref_folios));
    }
    if (args.use_attached_refs && userAttachments?.length) {
      collected = collected.concat(userAttachments);
    }
    return collected.slice(0, maxCount);
  }

  // ---- helper: 等待 task 进入完成态（视频是异步） ----
  async function waitTaskCompleted(task, timeoutMs = 180000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (chatAbort?.signal.aborted) return 'aborted';
      if (task.status === 'completed') return 'completed';
      if (task.status === 'failed') return 'failed';
      renderChat();  // 让 tool 卡片实时显示 task 进度（pollVideo 已在后台更新 task）
      await new Promise(r => setTimeout(r, 1500));
    }
    return 'timeout';
  }

  // 图像 - OpenAI 系
  if (name === 'generate_image_openai') {
    if (!backendCfg.imageConfigured) throw new Error('图像上游未配置');
    const endpoint = args.mode === 'image_edit' ? 'edits' : 'generations';
    const refList = await gatherRefs(6);
    if (endpoint === 'edits' && !refList.length) {
      throw new Error('image_edit 模式必须传至少 1 张参考图（use_attached_refs 或 ref_folios）');
    }
    const body = {
      model: 'gpt-image-2',
      prompt: args.prompt,
      size: args.size || '1024x1024',
      quality: args.quality || 'low',
      response_format: 'url',
      __endpoint: endpoint,
    };
    const n = Math.max(1, Math.min(6, parseInt(args.n || 1, 10) || 1));
    const t = await submitImageRaw(body, refList, { provider: 'openai', endpoint, n });
    // 多图时收集同 group 所有 task
    const groupTasks = (n > 1 && t.groupId) ? tasks.filter(x => x.groupId === t.groupId).sort((a, b) => a.folio - b.folio) : [t];
    return {
      taskLocalIds: groupTasks.map(x => x.localId),
      summary: n > 1 ? `已生成 ${n} 张（№${pad3(groupTasks[0].folio)}~№${pad3(groupTasks[groupTasks.length - 1].folio)}）` : `已提交 №${pad3(t.folio)}`,
    };
  }

  // 图像 - Gemini 系
  if (name === 'generate_image_gemini') {
    if (!backendCfg.imageConfigured) throw new Error('图像上游未配置');
    const model = args.model || 'nanobananapro';
    const aspectsAllowed = model === 'nanobanana2' ? GEMINI_ASPECTS_2 : GEMINI_ASPECTS_PRO;
    if (args.aspect_ratio && !aspectsAllowed.includes(args.aspect_ratio)) {
      throw new Error(`${model} 不支持 aspect_ratio=${args.aspect_ratio}，可选：${aspectsAllowed.join(' / ')}`);
    }
    const refList = await gatherRefs(6);
    const body = {
      contents: [{ role: 'user', parts: [{ text: args.prompt }] }],
      generation_config: {
        response_modalities: ['IMAGE'],
        image_config: {
          aspect_ratio: args.aspect_ratio || '1:1',
          image_size: args.image_size || '1K',
        },
      },
      __model: model,
    };
    const t = await submitImageRaw(body, refList, { provider: 'gemini', endpoint: 'generations' });
    return { taskLocalId: t.localId, summary: `已提交 №${pad3(t.folio)}` };
  }

  // 编辑已生成的图片
  if (name === 'edit_image') {
    if (!backendCfg.imageConfigured) throw new Error('图像上游未配置');
    if (typeof args.base_folio !== 'number') throw new Error('base_folio 必须是数字（已生成作品的任务号）');
    const baseList = await refsFromFolios([args.base_folio]);
    const extra = Array.isArray(args.ref_folios) ? await refsFromFolios(args.ref_folios) : [];
    const refList = [...baseList, ...extra].slice(0, 6);
    const body = {
      model: 'gpt-image-2',
      prompt: args.prompt,
      size: args.size || '1024x1024',
      quality: args.quality || 'low',
      response_format: 'url',
      __endpoint: 'edits',
    };
    const t = await submitImageRaw(body, refList, { provider: 'openai', endpoint: 'edits' });
    return { taskLocalId: t.localId, summary: `已基于 №${pad3(args.base_folio)} 编辑生成 №${pad3(t.folio)}` };
  }

  // 视频 - Sora
  if (name === 'generate_video_sora') {
    if (!backendCfg.videoUpstream) throw new Error('视频上游未配置');
    const body = {
      model: args.model || 'jimeng-v3-fast',
      prompt: args.prompt,
      size: args.size || '1280x720',
      seconds: String(args.seconds || 7),
    };
    const refList = args.use_attached_refs && userAttachments?.length ? userAttachments.slice(0, 4) : [];
    const t = await submitVideoRaw(body, refList, { provider: 'sora' });
    const final = await waitTaskCompleted(t, 300000);  // 视频较慢，等到 5 分钟
    if (final === 'completed') return { taskLocalId: t.localId, summary: `视频 №${pad3(t.folio)} 已完成（${Math.round((t.completedAt - t.createdAt) / 1000)} 秒）` };
    if (final === 'failed')    return { taskLocalId: t.localId, summary: `视频 №${pad3(t.folio)} 生成失败：${t.error || '未知'}` };
    if (final === 'aborted')   return { taskLocalId: t.localId, summary: `视频 №${pad3(t.folio)} 已提交但用户中断了等待，任务仍在后台运行` };
    return { taskLocalId: t.localId, summary: `视频 №${pad3(t.folio)} 已提交，当前 ${t.progress || 0}%，5 分钟内仍未完成。任务仍在后台轮询，稍后可用 list_recent_works 查看结果` };
  }

  // 视频 - Veo
  if (name === 'generate_video_veo') {
    if (!backendCfg.videoUpstream) throw new Error('视频上游未配置');
    const variant = args.variant || 'fast';
    const seconds = [4, 6, 8].includes(args.seconds) ? args.seconds : 4;
    let modelName;
    if (variant === 'fast') modelName = `gemini-veo-3.1-fast-generate-preview-${seconds}s`;
    else if (variant === 'ref') modelName = `gemini-veo-3.1-generate-preview-ref-${seconds}s`;
    else modelName = `gemini-veo-3.1-generate-preview-${seconds}s`;
    const body = {
      model: modelName,
      prompt: args.prompt,
      size: args.size || '1280x720',
    };
    if (args.generate_audio) body.generate_audio = true;
    if (args.negative_prompt && args.negative_prompt.trim()) body.negative_prompt = args.negative_prompt.trim();
    const maxRefs = variant === 'ref' ? 3 : 2;
    const refList = args.use_attached_refs && userAttachments?.length ? userAttachments.slice(0, maxRefs) : [];
    const t = await submitVideoRaw(body, refList, { provider: 'veo' });
    const final = await waitTaskCompleted(t, 300000);
    if (final === 'completed') return { taskLocalId: t.localId, summary: `Veo 视频 №${pad3(t.folio)} 已完成（${variant} · ${seconds}s · ${Math.round((t.completedAt - t.createdAt) / 1000)} 秒）` };
    if (final === 'failed')    return { taskLocalId: t.localId, summary: `Veo 视频 №${pad3(t.folio)} 生成失败：${t.error || '未知'}` };
    if (final === 'aborted')   return { taskLocalId: t.localId, summary: `Veo 视频 №${pad3(t.folio)} 已提交但用户中断了等待，任务仍在后台运行` };
    return { taskLocalId: t.localId, summary: `Veo 视频 №${pad3(t.folio)} 已提交，当前 ${t.progress || 0}%，5 分钟内仍未完成。任务仍在后台轮询，稍后可用 list_recent_works 查看结果` };
  }

  if (name === 'describe_reference_image') {
    const idx = args.attachment_index || 0;
    const ref = userAttachments?.[idx];
    if (!ref) return { text: '没有可用的参考图' };
    let dataUrl = ref.src;
    if (ref.kind === 'url') {
      try {
        const r = await fetch(ref.src);
        const blob = await r.blob();
        dataUrl = await new Promise((res, rej) => { const rd = new FileReader(); rd.onload = () => res(rd.result); rd.onerror = rej; rd.readAsDataURL(blob); });
      } catch { return { text: '参考图下载失败' }; }
    }
    const body = {
      model: getActiveLlmConfig().model,
      messages: [
        { role: 'system', content: '描述这张图，输出可作为生成模型 prompt 的英文段落。直接输出，不要前言。' },
        { role: 'user', content: [{ type: 'text', text: '描述这张图。' }, { type: 'image_url', image_url: { url: dataUrl } }] },
      ],
      temperature: 0.4,
    };
    const msg = await callLlmChat(body);
    return { text: msg?.content || '（无返回）' };
  }
  if (name === 'list_recent_works') {
    const limit = Math.min(args.limit || 6, 12);
    const recent = tasks.slice(0, limit).map(t => ({
      folio: t.folio,
      kind: t.kind,
      model: t.model,
      prompt: t.prompt.slice(0, 80),
      status: t.status,
      hasMedia: !!(t.imageUrl || t.imageDataUrl || (t.kind === 'video' && t.taskId && t.status === 'completed')),
    }));
    return { text: JSON.stringify(recent, null, 2) };
  }
  if (name === 'set_compose_form') {
    setMode(args.kind === 'video' ? 'video' : 'image');
    setPane('compose');
    const target = args.kind === 'video' ? '#vPrompt' : '#iPrompt';
    $(target).value = args.prompt || '';
    updatePromptCount(args.kind === 'video' ? 'video' : 'image');
    return { text: '已填入构图表单' };
  }
  throw new Error('未知工具：' + name);
}

// ---------- Agent 主循环 ----------
let chatBusy = false;
let chatAbort = null;
const MAX_TOOL_ROUNDS = 6;

async function sendChatMessage(text) {
  if (chatBusy) { toast('上一条还没完成', 'bad'); return; }
  if (!llmReady()) {
    toast('请先在「密钥」配置并启用 LLM', 'bad');
    openDrawer();
    return;
  }
  await ensureConversation();
  const conv = getCurrentConv();

  const userAttachments = chatAttachments.slice();
  const userMsg = {
    role: 'user',
    content: text,
    attachments: userAttachments,
    __ts: Date.now(),
  };
  conv.messages.push(userMsg);
  if (conv.messages.filter(m => m.role === 'user').length === 1 && conv.title === '未命名对话') {
    conv.title = text.slice(0, 18) + (text.length > 18 ? '…' : '');
  }
  conv.updatedAt = Date.now();
  chatAttachments = [];
  updateChatAttachInfo();
  await persistConversations();
  renderConvList();
  renderChat();

  await runAgentLoop();
}

function setChatBusy(busy) {
  const btn = $('#chatSend');
  if (!btn) return;
  if (busy) {
    btn.classList.add('is-busy', 'is-stop');
    btn.disabled = false;
    btn.querySelector('.btn-label').textContent = '停止';
  } else {
    btn.classList.remove('is-busy', 'is-stop');
    btn.disabled = false;
    btn.querySelector('.btn-label').textContent = '发送';
  }
  $('#chatStatus').textContent = busy ? '正在思考…（点停止可中断）' : '';
}

function stopChatGeneration() {
  if (chatAbort) {
    try { chatAbort.abort(); } catch {}
    chatAbort = null;
  }
}

function buildApiMessages(conv) {
  const out = [{ role: 'system', content: SYSTEM_PROMPT }];
  const cfg = getActiveLlmConfig();
  // 截断历史
  let messages = conv.messages.slice();
  if (cfg.contextWindow && cfg.contextWindow !== 'all') {
    const n = parseInt(cfg.contextWindow, 10);
    if (n > 0) {
      const limit = n * 3;
      messages = messages.slice(-limit);
    }
  }

  // ===== 上下文长度优化 =====
  // 1) tool messages 超过 KEEP_RECENT_TOOLS 个：旧的 content 替换为占位（保留 tool_call_id）
  // 2) 单条 tool content 超 MAX_TOOL_LEN 字符：截断
  // 3) tool_calls.arguments 超 MAX_TOOL_ARGS_LEN：截断（多见于 base64 参考图）
  const KEEP_RECENT_TOOLS = 20;
  const MAX_TOOL_LEN = 2000;
  const MAX_TOOL_ARGS_LEN = 1500;
  // 找出需要省略的旧 tool message
  const toolIdxs = [];
  messages.forEach((m, i) => { if (m.role === 'tool') toolIdxs.push(i); });
  const omitSet = new Set();
  if (toolIdxs.length > KEEP_RECENT_TOOLS) {
    const omitCount = toolIdxs.length - KEEP_RECENT_TOOLS;
    for (let i = 0; i < omitCount; i++) omitSet.add(toolIdxs[i]);
  }
  const truncate = (s, n) => {
    if (typeof s !== 'string' || s.length <= n) return s;
    return s.slice(0, n) + `\n…[已截断 ${s.length - n} 字符]`;
  };

  // 注入上下文状态给 LLM
  const draftTokens = estimateTokens([{ role: 'system', content: SYSTEM_PROMPT }, ...messages]);
  const limit = cfg.contextLimit || 32000;
  const remaining = Math.max(0, limit - draftTokens);
  const pct = Math.round((draftTokens / limit) * 100);
  let usageHint = '';
  if (pct >= 80) usageHint = '上下文紧张，可建议用户 /compress 压缩或简短回复。';
  else if (pct >= 60) usageHint = '上下文接近一半，注意控制回复长度。';
  else usageHint = '上下文充裕。';
  const optimizedNote = omitSet.size > 0 ? ` 已省略 ${omitSet.size} 个早期工具调用结果。` : '';
  out.push({
    role: 'system',
    content: `[上下文状态] 预估已用 ~${draftTokens} / ${limit} tokens（${pct}%），剩余 ~${remaining} tokens。${usageHint}${optimizedNote}`,
  });

  // 转换附件到 OpenAI 多模态 content；但只针对最后一条 user 消息附带（避免重复发图）
  const lastUserIdx = messages.map((m, i) => m.role === 'user' ? i : -1).filter(i => i >= 0).pop();
  messages.forEach((m, idx) => {
    if (m.role === 'system') {
      if (m.__summary || m.content) {
        out.push({ role: 'system', content: (m.__summary ? '[早期对话摘要]\n' : '') + (m.content || '') });
      }
    } else if (m.role === 'user') {
      if (idx === lastUserIdx && m.attachments && m.attachments.length) {
        const parts = [{ type: 'text', text: m.content }];
        for (const a of m.attachments) {
          parts.push({ type: 'image_url', image_url: { url: a.src } });
        }
        out.push({ role: 'user', content: parts });
      } else {
        out.push({ role: 'user', content: m.content });
      }
    } else if (m.role === 'assistant') {
      const o = { role: 'assistant', content: m.content || '' };
      if (m.tool_calls && m.tool_calls.length) {
        o.tool_calls = m.tool_calls.map(tc => {
          let args = typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments || {});
          // 截断大 base64 类参数
          args = args.replace(/"data:[^"]{200,}"/g, '"[image_data_url_truncated]"');
          args = args.replace(/"image":\s*"[^"]{200,}"/g, '"image":"[image_b64_truncated]"');
          args = truncate(args, MAX_TOOL_ARGS_LEN);
          return {
            id: tc.id,
            type: tc.type || 'function',
            function: { name: tc.function.name, arguments: args },
          };
        });
      }
      out.push(o);
    } else if (m.role === 'tool') {
      let content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      if (omitSet.has(idx)) {
        // 早期 tool 结果省略，但保留 tool_call_id
        content = '[早期工具结果已省略以节省上下文]';
      } else {
        // 截断单条
        // 也去除 data URL 类大数据
        content = content.replace(/"data:[^"]{200,}"/g, '"[image_data_url_truncated]"');
        content = truncate(content, MAX_TOOL_LEN);
      }
      out.push({ role: 'tool', tool_call_id: m.tool_call_id, name: m.name, content });
    }
  });
  return out;
}

// ---------- token 估算 + 容量条 ----------
function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (typeof p.text === 'string') chars += p.text.length;
        else if (typeof p === 'string') chars += p.length;
        else if (p.type === 'image_url' || p.type === 'input_image' || p.type === 'image') chars += 800; // 图片约等 800 token
      }
    }
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) chars += (tc.function?.arguments?.length || 0) + (tc.function?.name?.length || 0);
    }
  }
  // 中英文混合粗估：1 token ≈ 1.8 字符
  return Math.round(chars / 1.8);
}

function updateContextMeter() {
  const meter = $('#contextMeter');
  const bar = $('#ctxFill');
  const text = $('#ctxText');
  if (!meter || !bar || !text) return;
  const conv = getCurrentConv();
  const cfg = getActiveLlmConfig();
  let messages = conv ? conv.messages : [];
  // 含当前输入
  const inputText = $('#chatInput')?.value || '';
  const draftMsg = inputText ? [{ role: 'user', content: inputText }] : [];
  // 应用 contextWindow 截断
  let visible = messages;
  if (cfg.contextWindow && cfg.contextWindow !== 'all') {
    const n = parseInt(cfg.contextWindow, 10);
    if (n > 0) visible = visible.slice(-n * 3);
  }
  const tokens = estimateTokens([...visible, ...draftMsg]) + 500; // 加上 system prompt 估算
  const limit = cfg.contextLimit || 32000;
  const pct = Math.min(100, (tokens / limit) * 100);
  bar.style.width = pct + '%';
  meter.classList.remove('is-warn', 'is-danger');
  if (pct >= 90) meter.classList.add('is-danger');
  else if (pct >= 70) meter.classList.add('is-warn');
  const winText = cfg.contextWindow === 'all' ? `${messages.length} 条` : `保留最近 ${cfg.contextWindow} 条`;
  const profileName = getActiveProfile()?.name || '?';
  text.textContent = `${profileName} · ${winText} · 约 ${formatTokens(tokens)} / ${formatTokens(limit)} tokens`;
}

function formatTokens(n) {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return String(n);
}

// ---------- 附件 ----------
async function addChatAttachmentFile(file) {
  try {
    const ref = await preprocessRefFile(file);
    if (ref.compressed) toast(`已压缩 ${fmtBytes(ref.origSize)} → ${fmtBytes(ref.finalSize)}`, 'ok');
    chatAttachments.push({ kind: ref.kind, src: ref.src, size: ref.finalSize, origSize: ref.origSize, compressed: ref.compressed });
    updateChatAttachInfo();
  } catch {}
}
function updateChatAttachInfo() {
  const info = $('#chatAttachInfo');
  if (!info) return;
  info.textContent = chatAttachments.length ? `已附 ${chatAttachments.length} 张参考图` : '';
}

// ============================================================
// 主题（auto / light / dark）
// ============================================================
const THEMES = ['auto', 'light', 'dark'];
const THEME_GLYPH = { auto: '☉', light: '☀', dark: '☾' };
const THEME_NAME  = { auto: '跟随系统', light: '浅色', dark: '深色' };

function applyTheme() {
  document.documentElement.setAttribute('data-theme', settings.theme || 'auto');
  const g = $('#themeGlyph');
  if (g) g.textContent = THEME_GLYPH[settings.theme] || '☉';
  const btn = $('#themeToggle');
  if (btn) btn.title = '主题：' + (THEME_NAME[settings.theme] || 'auto');
}
async function cycleTheme() {
  const cur = settings.theme || 'auto';
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  settings.theme = next;
  applyTheme();
  await saveSettings();
  toast('主题：' + THEME_NAME[next], 'ok');
}

// ============================================================
// 提示词库（IndexedDB via KV — 一个数组）
// ============================================================
let library = [];

async function reloadLibrary() {
  const v = await KV.get('library', []);
  library = Array.isArray(v) ? v : [];
}
async function persistLibrary() {
  await KV.put('library', library);
}
function extractVars(text) {
  const set = new Set();
  const re = /\{([a-zA-Z0-9_]+)\}/g;
  let m;
  while ((m = re.exec(text)) !== null) set.add(m[1]);
  return Array.from(set);
}
function renderLibrary() {
  const root = $('#libList');
  if (!root) return;
  root.innerHTML = '';
  if (!library.length) {
    const li = document.createElement('li');
    li.innerHTML = '<div class="lib-empty">点击「+」保存当前 prompt 入库</div>';
    root.appendChild(li);
    return;
  }
  for (const item of library) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'recipe';
    btn.innerHTML = `
      <span class="lib-item">
        <span class="lib-item-name" title="${escapeHtml(item.body)}">${escapeHtml(item.name)}</span>
        ${item.vars && item.vars.length ? `<span class="lib-item-vars">{${item.vars.length}}</span>` : ''}
        <button class="lib-item-rm" type="button" title="删除">×</button>
      </span>
    `;
    btn.addEventListener('click', async (e) => {
      if (e.target.classList.contains('lib-item-rm')) {
        e.preventDefault();
        if (!(await uiConfirm(`删除「${item.name}」？`, { okText: '删除', danger: true }))) return;
        library = library.filter(x => x.id !== item.id);
        await persistLibrary();
        renderLibrary();
        return;
      }
      applyLibraryItem(item);
    });
    li.appendChild(btn);
    root.appendChild(li);
  }
}

async function saveCurrentPromptToLibrary() {
  const body = (currentMode === 'video' ? $('#vPrompt').value : $('#iPrompt').value).trim();
  if (!body) { toast('提示词为空，无可保存', 'bad'); return; }
  const name = await uiPrompt('给这条提示词起个名字：', body.slice(0, 18) + (body.length > 18 ? '…' : ''), { title: '保存到提示词库' });
  if (!name) return;
  const vars = extractVars(body);
  const item = {
    id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    name: name.trim(),
    body,
    vars,
    kind: 'both',
    createdAt: Date.now(),
  };
  library.unshift(item);
  await persistLibrary();
  renderLibrary();
  toast('已入库', 'ok');
}

function applyLibraryItem(item) {
  if (item.vars && item.vars.length) {
    openVarPop(item);
  } else {
    const target = currentMode === 'video' ? '#vPrompt' : '#iPrompt';
    $(target).value = item.body;
    updatePromptCount(currentMode);
    toast(`已套用「${item.name}」`, 'ok');
  }
}

// 变量浮窗
let varContext = null;
function openVarPop(item) {
  varContext = { item, values: {} };
  $('#varTitle').textContent = '· ' + item.name;
  const root = $('#varFields');
  root.innerHTML = '';
  for (const v of item.vars) {
    const wrap = document.createElement('div');
    wrap.className = 'var-field';
    wrap.innerHTML = `<span class="var-key">{${v}}</span>`;
    const inp = document.createElement('input');
    inp.className = 'inp';
    inp.placeholder = `${v}…`;
    inp.addEventListener('input', () => {
      varContext.values[v] = inp.value;
      $('#varPreview').textContent = renderVarPreview();
    });
    wrap.appendChild(inp);
    root.appendChild(wrap);
  }
  $('#varPreview').textContent = item.body;
  $('#varPop').hidden = false;
}
function renderVarPreview() {
  let out = varContext.item.body;
  for (const k of Object.keys(varContext.values)) {
    out = out.replace(new RegExp('\\{' + k + '\\}', 'g'), varContext.values[k] || `{${k}}`);
  }
  return out;
}
function closeVarPop() { $('#varPop').hidden = true; varContext = null; }
function applyVarPop() {
  const out = renderVarPreview();
  const target = currentMode === 'video' ? '#vPrompt' : '#iPrompt';
  $(target).value = out;
  updatePromptCount(currentMode);
  closeVarPop();
  toast('已填入', 'ok');
}

// ============================================================
// 代码导出（curl / Python / JS）
// ============================================================
let codeContext = null;
function openCodeForCurrentForm(mode) {
  if (mode === 'video') {
    const body = buildVideoBody();
    const r = refs.video.slice();
    if (r.length === 1) body.image = r[0].src;
    else if (r.length > 1) body.images = r.map(x => x.src);
    codeContext = { kind: 'video', path: '/v1/videos', body };
  } else {
    const { path, body } = buildImageRequest();
    const send = { ...body };
    delete send.__endpoint;
    delete send.__model;
    if (refs.image.length) {
      if (iProvider === 'openai') send.image = refs.image.map(r => r.src);
      // gemini provider 在 raw body 里已经有 parts，这里不放图保持代码简洁
    }
    codeContext = { kind: 'image', path, body: send, provider: iProvider };
  }
  $('#codePop').hidden = false;
  $$('#codeLang .seg-opt').forEach(b => b.classList.toggle('is-active', b.dataset.val === 'curl'));
  renderCode('curl');
}
function openCodeForTask(t) {
  if (t.kind === 'video') {
    codeContext = { kind: 'video', path: '/v1/videos', body: t.params, taskId: t.taskId };
  } else {
    let path;
    if (t.provider === 'openai') {
      const ep = (t.params && t.params.__endpoint) || 'generations';
      path = ep === 'edits' ? '/v1/images/edits' : '/v1/images/generations';
    } else {
      const m = (t.params && t.params.__model) || t.model;
      path = `/v1beta/models/${m}:generateContent`;
    }
    const body = { ...t.params };
    delete body.__endpoint; delete body.__model;
    codeContext = { kind: 'image', path, body, provider: t.provider };
  }
  $('#codePop').hidden = false;
  $$('#codeLang .seg-opt').forEach(b => b.classList.toggle('is-active', b.dataset.val === 'curl'));
  renderCode('curl');
}
function abbreviateBody(body) {
  const copy = JSON.parse(JSON.stringify(body));
  const abbreviate = (v) => {
    if (typeof v === 'string' && v.startsWith('data:') && v.length > 200) {
      return v.slice(0, 80) + '...<base64 truncated>...';
    }
    return v;
  };
  const walk = (o) => {
    if (Array.isArray(o)) return o.map(x => (typeof x === 'string' ? abbreviate(x) : (typeof x === 'object' && x ? walk(x) : x)));
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) o[k] = typeof o[k] === 'string' ? abbreviate(o[k]) : walk(o[k]);
      return o;
    }
    return o;
  };
  walk(copy);
  return copy;
}
function renderCode(lang) {
  if (!codeContext) return;
  const upstream = codeContext.kind === 'video' ? backendCfg.videoUpstream : backendCfg.imageUpstream;
  const base = upstream || 'https://your-api.example.com';
  const url = base.replace(/\/$/, '') + codeContext.path;
  const body = abbreviateBody(codeContext.body);
  const json = JSON.stringify(body, null, 2);
  let out = '';
  if (lang === 'curl') {
    out = `curl -X POST "${url}" \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '${json.replace(/'/g, "'\\''")}'`;
  } else if (lang === 'python') {
    out = `import requests, json

url = "${url}"
headers = {
    "Authorization": f"Bearer {TOKEN}",
    "Content-Type": "application/json",
}
body = ${json}

r = requests.post(url, headers=headers, json=body, timeout=300)
r.raise_for_status()
print(r.json())`;
  } else if (lang === 'js') {
    out = `const url = "${url}";
const body = ${json};

const r = await fetch(url, {
  method: "POST",
  headers: {
    "Authorization": \`Bearer \${TOKEN}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(300_000),
});
if (!r.ok) throw new Error(\`HTTP \${r.status}\`);
console.log(await r.json());`;
  }
  $('#codeOut').textContent = out;
}
function closeCodePop() { $('#codePop').hidden = true; codeContext = null; }
async function copyCode() {
  const text = $('#codeOut').textContent;
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板', 'ok');
  } catch {
    // 兜底：选中
    const range = document.createRange();
    range.selectNode($('#codeOut'));
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    toast('已选中，请手动复制', 'ok');
  }
}

// ============================================================
// Vision 反推
// ============================================================
async function reverseImageToPrompt(refItem) {
  if (!llmReady()) {
    toast('请先在「密钥」中配置并启用提示词增强', 'bad');
    openDrawer();
    return;
  }
  // 把图像转换成 base64 data URL（vision API 普遍接受这个）
  let dataUrl = refItem.src;
  if (refItem.kind === 'url') {
    try {
      const r = await fetch(refItem.src);
      const blob = await r.blob();
      dataUrl = await new Promise((res, rej) => {
        const rd = new FileReader();
        rd.onload = () => res(rd.result);
        rd.onerror = rej;
        rd.readAsDataURL(blob);
      });
    } catch (err) {
      toast('参考图下载失败，请改本地上传', 'bad');
      return;
    }
  }
  const persona = (settings.llmPersona && settings.llmPersona.trim()) ||
    '你是一位资深视觉描述专家。请仔细观察用户提供的参考图，输出一段地道流畅的英文 prompt，可直接用于生成式图像/视频模型。覆盖主体、构图、风格、材质、布光、配色、情绪、镜头。直接输出 prompt，不要前言/解释/引号。';
  const body = {
    model: getActiveLlmConfig().model,
    messages: [
      { role: 'system', content: persona },
      {
        role: 'user',
        content: [
          { type: 'text', text: '请描述这张图，输出一段可作为生成模型 prompt 的英文段落。' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0.6,
  };
  toast('正在反推 prompt…', 'ok');
  try {
    const msg = await callLlmChat(body);
    const out = msg?.content?.trim();
    if (!out) throw new Error('LLM 返回为空');
    const cleaned = out.replace(/^["'`]+|["'`]+$/g, '');
    const target = currentMode === 'video' ? '#vPrompt' : '#iPrompt';
    $(target).value = cleaned;
    updatePromptCount(currentMode);
    toast('已写入提示词', 'ok');
  } catch (err) {
    toast('反推失败：' + err.message, 'bad');
  }
}

// ============================================================
// 命令面板
// ============================================================
let cmdkActive = 0;
let cmdkFiltered = [];

function getCommands() {
  const cmds = [
    // 导航
    { id: 'goto-compose', section: '导航', title: '前往 · 构图',  icon: '▸', run: () => setPane('compose') },
    { id: 'goto-chat',    section: '导航', title: '前往 · 对话',  icon: '▸', run: () => setPane('chat') },
    { id: 'goto-queue',   section: '导航', title: '前往 · 任务',  icon: '▸', run: () => setPane('queue') },
    { id: 'goto-vault',   section: '导航', title: '前往 · 档案',  icon: '▸', run: () => setPane('vault') },
    { id: 'new-chat',     section: '导航', title: '新建对话',     icon: '+', run: newConversation },
    { id: 'open-keys',    section: '导航', title: '打开 · 密钥与配置', icon: '⊙', shortcut: 'Ctrl ,', run: openDrawer },

    // 模式
    { id: 'mode-video', section: '模式', title: '切换到 · 视频', icon: '◷', run: () => setMode('video') },
    { id: 'mode-image', section: '模式', title: '切换到 · 图像', icon: '▢', run: () => setMode('image') },

    // 操作
    { id: 'submit',  section: '操作', title: '生成当前表单', icon: '↵', shortcut: 'Ctrl ↵', run: () => (currentMode === 'video' ? maybeABSubmitVideo() : maybeABSubmitImage()) },
    { id: 'reset',   section: '操作', title: '重置当前表单', icon: '↺', run: () => { (currentMode === 'video' ? $('#vReset') : $('#iReset')).click(); } },
    { id: 'ab-cfg',  section: '操作', title: '配置 A/B 并行', icon: '⨯', run: () => openAbPop(currentMode) },
    { id: 'optimize',section: '提示词', title: 'LLM 优化当前提示词', icon: '↗', run: () => openLlmPop(currentMode === 'video' ? 'vPrompt' : 'iPrompt', currentMode, 'optimize') },
    { id: 'translate',section:'提示词', title: 'LLM 翻译当前提示词为英文', icon: '⇄', run: () => openLlmPop(currentMode === 'video' ? 'vPrompt' : 'iPrompt', currentMode, 'translate') },
    { id: 'save-lib',section: '提示词', title: '保存当前提示词到库', icon: '+', run: saveCurrentPromptToLibrary },
    { id: 'export-code', section: '操作', title: '导出当前表单为代码', icon: '⌘', run: () => openCodeForCurrentForm(currentMode) },

    // 视图
    { id: 'view-list', section: '视图', title: '任务用列表视图', icon: '☰', run: async () => { settings.queueView = 'list'; await saveSettings(); $$('#queueView .seg-opt').forEach(b => b.classList.toggle('is-active', b.dataset.val === 'list')); renderQueue(); } },
    { id: 'view-grid', section: '视图', title: '任务用网格视图', icon: '▦', shortcut: 'Ctrl L', run: async () => { settings.queueView = 'grid'; await saveSettings(); $$('#queueView .seg-opt').forEach(b => b.classList.toggle('is-active', b.dataset.val === 'grid')); renderQueue(); } },
    { id: 'clear',     section: '视图', title: '清理已结束任务',  icon: '×', run: () => $('#queueClear').click() },

    // 套式
    { id: 'recipe-cinematic', section: '套式', title: '套式 · 电影感', icon: '☀', run: () => applyRecipe('cinematic') },
    { id: 'recipe-product',   section: '套式', title: '套式 · 产品转台', icon: '◯', run: () => applyRecipe('product') },
    { id: 'recipe-portrait',  section: '套式', title: '套式 · 人物特写', icon: '☻', run: () => applyRecipe('portrait') },
    { id: 'recipe-poster',    section: '套式', title: '套式 · 极简海报', icon: '▣', run: () => applyRecipe('poster') },
  ];

  // 库条目
  for (const it of library) {
    cmds.push({
      id: 'lib-' + it.id,
      section: '提示词库',
      title: it.name,
      sub: it.vars && it.vars.length ? `（${it.vars.length} 个变量）` : '',
      icon: '✎',
      run: () => applyLibraryItem(it),
    });
  }

  // 最近任务
  for (const t of tasks.slice(0, 6)) {
    cmds.push({
      id: 'task-' + t.localId,
      section: '最近任务',
      title: `№${pad3(t.folio)} · ${t.prompt.slice(0, 40)}`,
      sub: `${KIND_TEXT[t.kind]} · ${STATUS_TEXT[t.status] || t.status}`,
      icon: '◊',
      run: () => openModal(t),
    });
  }

  return cmds;
}

function fuzzyMatch(s, q) {
  if (!q) return true;
  s = s.toLowerCase();
  q = q.toLowerCase();
  let i = 0;
  for (const c of s) {
    if (c === q[i]) i++;
    if (i >= q.length) return true;
  }
  return i >= q.length;
}

function renderCmdk(query) {
  const all = getCommands();
  const filtered = query ? all.filter(c => fuzzyMatch(c.title, query) || fuzzyMatch(c.section, query)) : all;
  cmdkFiltered = filtered;
  cmdkActive = Math.min(cmdkActive, filtered.length - 1);
  if (cmdkActive < 0) cmdkActive = 0;
  const list = $('#cmdkList');
  list.innerHTML = '';
  if (!filtered.length) {
    list.innerHTML = '<div class="cmdk-empty">无匹配项</div>';
    return;
  }
  let lastSection = null;
  filtered.forEach((c, idx) => {
    if (c.section !== lastSection) {
      const sh = document.createElement('div');
      sh.className = 'cmdk-section';
      sh.textContent = c.section;
      list.appendChild(sh);
      lastSection = c.section;
    }
    const item = document.createElement('div');
    item.className = 'cmdk-item' + (idx === cmdkActive ? ' is-active' : '');
    item.innerHTML = `
      <span class="cmdk-icon">${c.icon || ''}</span>
      <span class="cmdk-title">${escapeHtml(c.title)}${c.sub ? `<span class="cmdk-sub">${escapeHtml(c.sub)}</span>` : ''}</span>
      ${c.shortcut ? `<span class="cmdk-shortcut">${c.shortcut}</span>` : ''}
    `;
    item.addEventListener('mouseenter', () => { cmdkActive = idx; updateCmdkActive(); });
    item.addEventListener('click', () => execCmdk());
    list.appendChild(item);
  });
}
function updateCmdkActive() {
  $$('#cmdkList .cmdk-item').forEach((el, i) => el.classList.toggle('is-active', i === cmdkActive));
  const active = $('#cmdkList .cmdk-item.is-active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}
function openCmdk() {
  $('#cmdkMask').hidden = false;
  $('#cmdk').hidden = false;
  $('#cmdkInput').value = '';
  cmdkActive = 0;
  renderCmdk('');
  setTimeout(() => $('#cmdkInput').focus(), 10);
}
function closeCmdk() {
  $('#cmdkMask').hidden = true;
  $('#cmdk').hidden = true;
}
function execCmdk() {
  const cmd = cmdkFiltered[cmdkActive];
  if (!cmd) return;
  closeCmdk();
  setTimeout(() => cmd.run(), 30);
}

// ============================================================
// 全局快捷键
// ============================================================
let gPrefix = null; // 'g' prefix 接收下一个键
function bindHotkeys() {
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const tag = (e.target.tagName || '').toLowerCase();
    const isInput = tag === 'input' || tag === 'textarea' || (e.target.isContentEditable);

    // Ctrl/Cmd + K — 命令面板
    if (mod && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if ($('#cmdk').hidden) openCmdk(); else closeCmdk();
      return;
    }
    // Ctrl/Cmd + Enter — 提交当前表单
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      if (currentPane !== 'compose') setPane('compose');
      if (currentMode === 'video') maybeABSubmitVideo();
      else maybeABSubmitImage();
      return;
    }
    // Ctrl/Cmd + , — 设置
    if (mod && e.key === ',') {
      e.preventDefault();
      openDrawer();
      return;
    }
    // Ctrl/Cmd + L — 切换列表/网格
    if (mod && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      const newView = settings.queueView === 'grid' ? 'list' : 'grid';
      settings.queueView = newView;
      saveSettings();
      $$('#queueView .seg-opt').forEach(b => b.classList.toggle('is-active', b.dataset.val === newView));
      setPane('queue');
      renderQueue();
      return;
    }

    // 输入框中不响应剩余按键
    if (isInput) return;

    // 命令面板中（cmdk）会自己处理
    if (!$('#cmdk').hidden) return;

    // Esc — 关弹窗（modal/drawer 等已绑过，这里管 cmdk/var/code）
    if (e.key === 'Escape') {
      if (!$('#cmdk').hidden) { closeCmdk(); return; }
      if (!$('#varPop').hidden) { closeVarPop(); return; }
      if (!$('#codePop').hidden) { closeCodePop(); return; }
      if (!$('#abPop').hidden) { closeAbPop(); return; }
    }

    // "/" — 聚焦 prompt
    if (e.key === '/' && !mod) {
      e.preventDefault();
      const target = currentMode === 'video' ? '#vPrompt' : '#iPrompt';
      $(target).focus();
      return;
    }
    // Vim 风跳转：g 然后 c/q/v/s
    if (e.key === 'g' && !mod) {
      gPrefix = setTimeout(() => { gPrefix = null; }, 1200);
      return;
    }
    if (gPrefix) {
      clearTimeout(gPrefix);
      gPrefix = null;
      if (e.key === 'c') { setPane('compose'); return; }
      if (e.key === 'q') { setPane('queue'); return; }
      if (e.key === 'v') { setPane('vault'); return; }
      if (e.key === 'a') { setPane('chat'); return; }
      if (e.key === 's') { openDrawer(); return; }
    }
    // 数字 1 / 2 切模式
    if (e.key === '1' && !mod) { setMode('video'); return; }
    if (e.key === '2' && !mod) { setMode('image'); return; }
  });

  // cmdk 输入处理
  $('#cmdkInput').addEventListener('input', (e) => {
    cmdkActive = 0;
    renderCmdk(e.target.value);
  });
  $('#cmdkInput').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cmdkActive = Math.min(cmdkFiltered.length - 1, cmdkActive + 1);
      updateCmdkActive();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      cmdkActive = Math.max(0, cmdkActive - 1);
      updateCmdkActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      execCmdk();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeCmdk();
    }
  });
  // 命令面板入口
  $('#openCmdk').addEventListener('click', openCmdk);
  // 提示词库入口
  $('#lib-add').addEventListener('click', saveCurrentPromptToLibrary);
  // 变量浮窗
  $('#varClose').addEventListener('click', closeVarPop);
  $('#varApply').addEventListener('click', applyVarPop);
  // 代码导出浮窗
  $('#codeClose').addEventListener('click', closeCodePop);
  $('#codeCopy').addEventListener('click', copyCode);
  $$('#codeLang .seg-opt').forEach(b => b.addEventListener('click', () => {
    $$('#codeLang .seg-opt').forEach(x => x.classList.toggle('is-active', x === b));
    renderCode(b.dataset.val);
  }));
  // 表单上「导出代码」入口
  $$('[data-export-code]').forEach(b => b.addEventListener('click', () => {
    openCodeForCurrentForm(b.dataset.exportCode);
  }));
  // 最近生成
  $('#recentGoto').addEventListener('click', () => setPane('queue'));
  // 主题切换
  $('#themeToggle').addEventListener('click', cycleTheme);
  // 使用教程
  $('#openGuide').addEventListener('click', openGuide);
  $('#closeGuide').addEventListener('click', closeGuide);
  $('#guideMask').addEventListener('click', closeGuide);

  // 窗口尺寸变化时刷新 recent（控制宽屏显隐）
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderRecent, 120);
  });

  // 档案多选
  $('#vaultSelectMode').addEventListener('click', () => setVaultSelectMode(!vaultSelectMode));
  $('#vaultSelectClear').addEventListener('click', () => setVaultSelectMode(false));
  $('#vaultSelectAll').addEventListener('click', () => {
    tasks.filter(t => t.status === 'completed').forEach(t => vaultSelected.add(t.localId));
    renderVault();
    updateVaultSelection();
  });
  $('#vaultDownload').addEventListener('click', downloadSelectedAsZip);

  // ---------- 对话 ----------
  $('#chatNew').addEventListener('click', newConversation);
  $('#chatRename').addEventListener('click', async () => {
    const c = getCurrentConv();
    if (!c) return;
    const name = await uiPrompt('重命名对话：', c.title, { title: '重命名对话' });
    if (name && name.trim()) renameConversation(c.id, name.trim());
  });
  $('#chatDelete').addEventListener('click', async () => {
    const c = getCurrentConv();
    if (!c) return;
    if (await uiConfirm(`删除对话「${c.title}」？`, { okText: '删除', danger: true })) deleteConversation(c.id);
  });
  $('#chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (chatBusy) {
      stopChatGeneration();
      toast('已中断生成', 'ok');
      return;
    }
    const text = $('#chatInput').value.trim();
    if (!text) return;
    // 斜杠命令
    if (text.startsWith('/')) {
      runSlashCommand(text);
      $('#chatInput').value = '';
      closeSlashMenu();
      updateContextMeter();
      return;
    }
    $('#chatInput').value = '';
    closeSlashMenu();
    updateContextMeter();
    sendChatMessage(text);
  });
  $('#chatInput').addEventListener('keydown', (e) => {
    const menuOpen = !$('#slashMenu').hidden;
    if (menuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        slashActiveIdx = Math.min(slashFiltered.length - 1, slashActiveIdx + 1);
        renderSlashMenu($('#chatInput').value);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        slashActiveIdx = Math.max(0, slashActiveIdx - 1);
        renderSlashMenu($('#chatInput').value);
        return;
      }
      if ((e.key === 'Tab' || e.key === 'Enter') && !e.shiftKey) {
        e.preventDefault();
        acceptSlash();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSlashMenu();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      $('#chatForm').dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });
  $('#chatInput').addEventListener('input', () => {
    const v = $('#chatInput').value;
    // 仅当全文以 / 开头且没有空格（一行命令）时弹菜单
    if (v.startsWith('/') && !v.includes('\n')) {
      slashActiveIdx = 0;
      renderSlashMenu(v.split(' ')[0]);
    } else {
      closeSlashMenu();
    }
    updateContextMeter();
  });
  $('#chatAttachBtn').addEventListener('click', () => $('#chatAttach').click());
  $('#chatAttach').addEventListener('change', async () => {
    for (const f of $('#chatAttach').files) {
      if (f.type.startsWith('image/')) await addChatAttachmentFile(f);
    }
    $('#chatAttach').value = '';
  });

  // 调试控制台
  $('#chatDebugToggle').addEventListener('click', () => {
    const open = $('#chatDebug').hidden;
    $('#chatDebug').hidden = !open;
    $('#chatDebugToggle').classList.toggle('is-on', open);
    if (open) renderDebugPanel();
  });
  $('#chatDebugClose').addEventListener('click', () => {
    $('#chatDebug').hidden = true;
    $('#chatDebugToggle').classList.remove('is-on');
  });
  $('#chatDebugClear').addEventListener('click', () => {
    llmDebugLog.length = 0;
    renderDebugPanel();
  });
}
