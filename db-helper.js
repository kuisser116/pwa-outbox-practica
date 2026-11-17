/*
 * db-helper.js
 * Mini-wrapper promisificado de IndexedDB (JavaScript Vanilla).
 *
 * Se carga tanto en la interfaz (index.html -> script) como dentro del
 * Service Worker (sw.js -> importScripts('./db-helper.js')).
 * Por eso este archivo no toca window ni document.
 *
 * Toda la asincronia se resuelve con new Promise(), .then() y .catch().
 * No se usa ninguna libreria externa.
 */

'use strict';

const DB_NAME = 'pwa-outbox-db';
const DB_VERSION = 1;
const STORE_NAME = 'transacciones_pendientes';

let dbPromise = null;

/**
 * Pieza 1: apertura y migracion de esquema.
 * Las Object Store SOLO se crean dentro de onupgradeneeded.
 */
function abrirDB() {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise(function (resolve, reject) {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = function (evento) {
      const db = evento.target.result;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: 'id',
          autoIncrement: true
        });
        store.createIndex('por_fecha', 'fechaCreacion', { unique: false });
        store.createIndex('por_estado', 'estado', { unique: false });
      }

      if (!db.objectStoreNames.contains('catalogo')) {
        db.createObjectStore('catalogo', { keyPath: 'sku' });
      }
    };

    request.onsuccess = function (evento) {
      const db = evento.target.result;

      // Si otra pestana pide subir la version, soltamos esta conexion.
      db.onversionchange = function () {
        db.close();
        dbPromise = null;
      };

      resolve(db);
    };

    request.onerror = function (evento) {
      dbPromise = null;
      reject(evento.target.error || new Error('No se pudo abrir IndexedDB'));
    };

    request.onblocked = function () {
      reject(new Error('La base esta bloqueada por otra pestana abierta'));
    };
  });

  return dbPromise;
}

/**
 * Pieza 2: escritura segura (CREATE).
 * store.add() entrega el id, pero el dato no esta en disco hasta tx.oncomplete.
 */
function guardarRegistro(datos) {
  return abrirDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.add(datos);
      let idGenerado;

      req.onsuccess = function (evento) {
        idGenerado = evento.target.result;
      };

      tx.oncomplete = function () {
        resolve(idGenerado);
      };

      tx.onerror = function (evento) {
        reject(evento.target.error || new Error('Fallo al guardar el registro'));
      };

      tx.onabort = function (evento) {
        reject(evento.target.error || new Error('Transaccion abortada'));
      };
    });
  });
}

/**
 * Pieza 3: lectura completa (READ) en modo readonly.
 */
function obtenerTodosLosRegistros() {
  return abrirDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction([STORE_NAME], 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();

      req.onsuccess = function (evento) {
        resolve(evento.target.result || []);
      };

      req.onerror = function (evento) {
        reject(evento.target.error || new Error('Fallo al leer los registros'));
      };
    });
  });
}

/**
 * Lectura filtrada por el indice 'por_estado'.
 * Auxiliar del patron Outbox: evita traer toda la cola para reenviar.
 */
function obtenerRegistrosPorEstado(estado) {
  return abrirDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction([STORE_NAME], 'readonly');
      const indice = tx.objectStore(STORE_NAME).index('por_estado');
      const req = indice.getAll(estado);

      req.onsuccess = function (evento) {
        resolve(evento.target.result || []);
      };

      req.onerror = function (evento) {
        reject(evento.target.error || new Error('Fallo al filtrar por estado'));
      };
    });
  });
}

/**
 * UPDATE: cambia el estado dentro de UNA sola transaccion readwrite.
 * Primero lee con store.get(id) y en su onsuccess sobrescribe con store.put().
 */
function actualizarEstadoRegistro(id, nuevoEstado) {
  return abrirDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      // 1. Obtener el registro actual por su llave primaria
      const reqGet = store.get(id);

      reqGet.onsuccess = function (evento) {
        const registro = evento.target.result;

        if (!registro) {
          reject(new Error('No se encontro el registro con ID: ' + id));
          return;
        }

        // 2. Modificar la propiedad y sobrescribir con .put()
        registro.estado = nuevoEstado;
        registro.fechaSincronizacion = Date.now();
        store.put(registro);
      };

      reqGet.onerror = function (evento) {
        reject(evento.target.error || new Error('Fallo al leer el registro'));
      };

      // 3. Resolver cuando la transaccion completa el guardado en disco
      tx.oncomplete = function () {
        resolve(true);
      };

      tx.onerror = function (evento) {
        reject(evento.target.error || new Error('Fallo al actualizar el registro'));
      };
    });
  });
}

/**
 * UPDATE auxiliar: cuenta un intento fallido de envio sin tocar el estado.
 */
function incrementarIntentos(id) {
  return abrirDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const reqGet = store.get(id);

      reqGet.onsuccess = function (evento) {
        const registro = evento.target.result;

        if (!registro) {
          reject(new Error('No se encontro el registro con ID: ' + id));
          return;
        }

        registro.intentos = (registro.intentos || 0) + 1;
        registro.ultimoIntento = Date.now();
        store.put(registro);
      };

      tx.oncomplete = function () {
        resolve(true);
      };

      tx.onerror = function (evento) {
        reject(evento.target.error || new Error('Fallo al sumar intentos'));
      };
    });
  });
}

/**
 * Pieza 4: eliminacion por llave primaria (DELETE).
 */
function eliminarRegistro(id) {
  return abrirDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      store.delete(id);

      tx.oncomplete = function () {
        resolve(true);
      };

      tx.onerror = function (evento) {
        reject(evento.target.error || new Error('Fallo al eliminar el registro'));
      };
    });
  });
}

/**
 * DELETE masivo: purga varios ids en una sola transaccion.
 */
function eliminarRegistros(ids) {
  if (!ids || ids.length === 0) {
    return Promise.resolve(0);
  }

  return abrirDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      ids.forEach(function (id) {
        store.delete(id);
      });

      tx.oncomplete = function () {
        resolve(ids.length);
      };

      tx.onerror = function (evento) {
        reject(evento.target.error || new Error('Fallo al purgar registros'));
      };
    });
  });
}

/**
 * Conteo rapido para el badge de la interfaz.
 */
function contarRegistros() {
  return abrirDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      const tx = db.transaction([STORE_NAME], 'readonly');
      const req = tx.objectStore(STORE_NAME).count();

      req.onsuccess = function (evento) {
        resolve(evento.target.result);
      };

      req.onerror = function (evento) {
        reject(evento.target.error || new Error('Fallo al contar registros'));
      };
    });
  });
}

/*
 * Exposicion global: las funciones quedan en el ambito global para que app.js
 * y sw.js las usen directo (guardarRegistro, obtenerTodosLosRegistros, etc.).
 * DBHelper se conserva como espacio de nombres ordenado.
 */
const DBHelper = {
  DB_NAME: DB_NAME,
  DB_VERSION: DB_VERSION,
  STORE_NAME: STORE_NAME,
  abrirDB: abrirDB,
  guardarRegistro: guardarRegistro,
  obtenerTodosLosRegistros: obtenerTodosLosRegistros,
  obtenerRegistrosPorEstado: obtenerRegistrosPorEstado,
  actualizarEstadoRegistro: actualizarEstadoRegistro,
  incrementarIntentos: incrementarIntentos,
  eliminarRegistro: eliminarRegistro,
  eliminarRegistros: eliminarRegistros,
  contarRegistros: contarRegistros
};

if (typeof self !== 'undefined') {
  self.DBHelper = DBHelper;
}
