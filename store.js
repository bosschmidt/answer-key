// IndexedDB: books (decrypted), attempts (the log), results (last result per exercise), flags, kv (key, position).

const DB_NAME = 'answer-key';
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('books', { keyPath: 'id' });
        db.createObjectStore('attempts', { autoIncrement: true }).createIndex('book', 'book');
        db.createObjectStore('results', { keyPath: 'key' }).createIndex('book', 'book');
        db.createObjectStore('flags', { keyPath: 'key' });
        db.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run(store, mode, work) {
  return open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = work(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = tx.onabort = () => reject(tx.error);
  }));
}

export const get = (store, key) => run(store, 'readonly', s => s.get(key));
export const all = store => run(store, 'readonly', s => s.getAll());
export const put = (store, value, key) => run(store, 'readwrite', s => (key === undefined ? s.put(value) : s.put(value, key)));
export const del = (store, key) => run(store, 'readwrite', s => s.delete(key));
export const byBook = (store, book) => run(store, 'readonly', s => s.index('book').getAll(book));

export const exerciseKey = (book, unit, n) => `${book}|${unit}|${n}`;

// One attempt: appended to the log, and kept as the exercise's last result.
export async function logAttempt(book, unit, n, sure, right, at) {
  const entry = { book, unit, n, sure, right, at };
  await put('attempts', entry);
  await put('results', { key: exerciseKey(book, unit, n), ...entry });
}
