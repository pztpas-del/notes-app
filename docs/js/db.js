// Tiny IndexedDB wrapper: the device's offline copy of every note.
const DB_NAME = 'notes-app';
let opening = null;

function open() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('files', { keyPath: 'path' });
        req.result.createObjectStore('kv');
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

export const db = {
  allFiles: () => run('files', 'readonly', s => s.getAll()),
  saveFiles: (records, removedPaths) => run('files', 'readwrite', s => {
    for (const r of records) s.put(r);
    for (const p of removedPaths) s.delete(p);
  }),
  get: key => run('kv', 'readonly', s => s.get(key)),
  set: (key, value) => run('kv', 'readwrite', s => { s.put(value, key); }),
};
