'use strict';

const DB_NAME = 'pwa-outbox-db';
const DB_VERSION = 1;
const STORE = 'transacciones_pendientes';
let dbPromise = null;

function abrirDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(function (resolve, reject) {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function (e) {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        s.createIndex('por_fecha', 'fechaCreacion', { unique: false });
        s.createIndex('por_estado', 'estado', { unique: false });
      }
      if (!db.objectStoreNames.contains('catalogo')) db.createObjectStore('catalogo', { keyPath: 'sku' });
    };
    req.onsuccess = function (e) {
      const db = e.target.result;
      db.onversionchange = function () { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = function (e) { dbPromise = null; reject(e.target.error || new Error('No se pudo abrir IndexedDB')); };
    req.onblocked = function () { reject(new Error('Base bloqueada por otra pestaña')); };
  });
  return dbPromise;
}

function guardarRegistro(datos) {
  return abrirDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction([STORE], 'readwrite');
      const req = tx.objectStore(STORE).add(datos);
      let id;
      req.onsuccess = function (e) { id = e.target.result; };
      tx.oncomplete = function () { resolve(id); };
      tx.onerror = function (e) { reject(e.target.error || new Error('Fallo al guardar')); };
      tx.onabort = function (e) { reject(e.target.error || new Error('Transacción abortada')); };
    });
  });
}

function obtenerTodosLosRegistros() {
  return abrirDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      const req = db.transaction([STORE], 'readonly').objectStore(STORE).getAll();
      req.onsuccess = function (e) { resolve(e.target.result || []); };
      req.onerror = function (e) { reject(e.target.error || new Error('Fallo al leer')); };
    });
  });
}

function actualizarEstadoRegistro(id, nuevoEstado) {
  return abrirDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction([STORE], 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.get(id);
      req.onsuccess = function (e) {
        const r = e.target.result;
        if (!r) { reject(new Error('No existe el registro ' + id)); return; }
        r.estado = nuevoEstado;
        r.fechaSincronizacion = Date.now();
        store.put(r);
      };
      req.onerror = function (e) { reject(e.target.error || new Error('Fallo al leer')); };
      tx.oncomplete = function () { resolve(true); };
      tx.onerror = function (e) { reject(e.target.error || new Error('Fallo al actualizar')); };
    });
  });
}

function incrementarIntentos(id) {
  return abrirDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction([STORE], 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.get(id);
      req.onsuccess = function (e) {
        const r = e.target.result;
        if (!r) { reject(new Error('No existe el registro ' + id)); return; }
        r.intentos = (r.intentos || 0) + 1;
        r.ultimoIntento = Date.now();
        store.put(r);
      };
      tx.oncomplete = function () { resolve(true); };
      tx.onerror = function (e) { reject(e.target.error || new Error('Fallo al sumar intentos')); };
    });
  });
}

function eliminarRegistro(id) {
  return abrirDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction([STORE], 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = function () { resolve(true); };
      tx.onerror = function (e) { reject(e.target.error || new Error('Fallo al eliminar')); };
    });
  });
}
