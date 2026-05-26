/* ============================================================
   storage.js — IndexedDB 封装
   - 一个 db，三个 store：tasks / kv（settings/edition） / blobs（参考图、结果图大数据）
   - 启动时自动从 localStorage 迁移旧数据，迁移成功后清空旧 key
   - 暴露的接口都是 async / Promise，调用方按 await 用
   ============================================================ */

const DB_NAME = 'atelier';
const DB_VER  = 1;
const STORE_TASKS = 'tasks';
const STORE_KV    = 'kv';
const STORE_BLOBS = 'blobs';

const LEGACY = {
  tasks:    'atelier.tasks.v1',
  settings: 'atelier.settings.v1',
  edition:  'atelier.edition.v1',
};

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_TASKS)) {
        const s = db.createObjectStore(STORE_TASKS, { keyPath: 'localId' });
        s.createIndex('createdAt', 'createdAt', { unique: false });
        s.createIndex('status',    'status',    { unique: false });
        s.createIndex('groupId',   'groupId',   { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_KV)) {
        db.createObjectStore(STORE_KV);
      }
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode = 'readonly') {
  return openDb().then(db => db.transaction(storeName, mode).objectStore(storeName));
}

function reqAsPromise(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror   = () => reject(r.error);
  });
}

// ---------- tasks ----------
export const Tasks = {
  async list() {
    const s = await tx(STORE_TASKS);
    const all = await reqAsPromise(s.getAll());
    return all.sort((a, b) => b.createdAt - a.createdAt);
  },
  async get(localId) {
    const s = await tx(STORE_TASKS);
    return reqAsPromise(s.get(localId));
  },
  async put(task) {
    const s = await tx(STORE_TASKS, 'readwrite');
    return reqAsPromise(s.put(task));
  },
  async delete(localId) {
    const s = await tx(STORE_TASKS, 'readwrite');
    return reqAsPromise(s.delete(localId));
  },
  async clearCompleted() {
    const s = await tx(STORE_TASKS, 'readwrite');
    return new Promise((resolve, reject) => {
      const req = s.openCursor();
      req.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) return resolve();
        if (cur.value.status === 'completed') cur.delete();
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  },
  async listByGroup(groupId) {
    const s = await tx(STORE_TASKS);
    const idx = s.index('groupId');
    return reqAsPromise(idx.getAll(groupId));
  },
};

// ---------- key-value (settings, edition) ----------
export const KV = {
  async get(key, fallback) {
    const s = await tx(STORE_KV);
    const v = await reqAsPromise(s.get(key));
    return v === undefined ? fallback : v;
  },
  async put(key, value) {
    const s = await tx(STORE_KV, 'readwrite');
    return reqAsPromise(s.put(value, key));
  },
  async delete(key) {
    const s = await tx(STORE_KV, 'readwrite');
    return reqAsPromise(s.delete(key));
  },
};

// ---------- blobs (大数据，与 task 解耦) ----------
export const Blobs = {
  async put(id, data) {
    const s = await tx(STORE_BLOBS, 'readwrite');
    return reqAsPromise(s.put(data, id));
  },
  async get(id) {
    const s = await tx(STORE_BLOBS);
    return reqAsPromise(s.get(id));
  },
  async delete(id) {
    const s = await tx(STORE_BLOBS, 'readwrite');
    return reqAsPromise(s.delete(id));
  },
};

// ---------- 一次性从 localStorage 迁移 ----------
export async function migrateFromLocalStorage() {
  const flag = await KV.get('migrated.v1', false);
  if (flag) return;

  try {
    const tasksRaw = localStorage.getItem(LEGACY.tasks);
    if (tasksRaw) {
      const arr = JSON.parse(tasksRaw);
      if (Array.isArray(arr)) {
        for (const t of arr) {
          if (!t.localId) t.localId = 'L' + Math.random().toString(36).slice(2);
          await Tasks.put(t);
        }
      }
    }
    const settingsRaw = localStorage.getItem(LEGACY.settings);
    if (settingsRaw) {
      await KV.put('settings', JSON.parse(settingsRaw));
    }
    const editionRaw = localStorage.getItem(LEGACY.edition);
    if (editionRaw) {
      await KV.put('edition', parseInt(editionRaw, 10) || 0);
    }
  } catch (err) {
    console.warn('[migrate] failed', err);
  }

  await KV.put('migrated.v1', true);
  try {
    localStorage.removeItem(LEGACY.tasks);
    localStorage.removeItem(LEGACY.settings);
    localStorage.removeItem(LEGACY.edition);
  } catch {}
}

export async function wipeAll() {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const t = db.transaction([STORE_TASKS, STORE_KV, STORE_BLOBS], 'readwrite');
    t.objectStore(STORE_TASKS).clear();
    t.objectStore(STORE_KV).clear();
    t.objectStore(STORE_BLOBS).clear();
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
  try {
    localStorage.removeItem(LEGACY.tasks);
    localStorage.removeItem(LEGACY.settings);
    localStorage.removeItem(LEGACY.edition);
  } catch {}
}

// ---------- 工具：DataURL 字符串体积估算（字节数，避免巨大 task） ----------
export function dataUrlSize(s) {
  if (!s || typeof s !== 'string') return 0;
  return Math.floor(s.length * 0.75);
}
