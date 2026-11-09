// Tiny IndexedDB wrapper: the device's offline copy of every note, plus
// pictures and files kept on this device (waiting for upload or recently opened).
const DB_NAME = 'notes-app';
let opening = null;

function open() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'path' });
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('media')) d.createObjectStore('media', { keyPath: 'path' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return opening;
}

async function run(storeName, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const out = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Media records: { path, blob, size, pending, at }
//   pending - not on Yandex Disk yet; at - last time it was used (for clean-up)
// Listing reads only the metadata, so big files are not pulled into memory.
async function mediaMeta() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const out = [];
    const tx = db.transaction('media', 'readonly');
    const req = tx.objectStore('media').openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      const { path, size, pending, at } = c.value;
      out.push({ path, size, pending, at });
      c.continue();
    };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
  });
}

export const db = {
  allFiles: () => run('files', 'readonly', s => s.getAll()),
  saveFiles: (records, removedPaths) => run('files', 'readwrite', s => {
    for (const r of records) s.put(r);
    for (const p of removedPaths) s.delete(p);
  }),
  get: key => run('kv', 'readonly', s => s.get(key)),
  set: (key, value) => run('kv', 'readwrite', s => { s.put(value, key); }),
  media: {
    meta: mediaMeta,
    get: path => run('media', 'readonly', s => s.get(path)),
    put: rec => run('media', 'readwrite', s => { s.put(rec); }),
    del: path => run('media', 'readwrite', s => { s.delete(path); }),
  },
};
