/*
 * sw.js
 * Service Worker: App Shell en Cache API + motor de sincronizacion en segundo
 * plano con Background Sync API.
 *
 * Aqui NO existen window ni document. Todo aviso a la interfaz se hace con
 * clients.matchAll() + postMessage.
 *
 * Toda la asincronia se resuelve con Promesas explicitas.
 */

importScripts('./db-helper.js');

const CACHE_STATIC_NAME = 'static-outbox-v2';
const ENDPOINT = 'https://jsonplaceholder.typicode.com/posts';

const STATIC_FILES = [
  './',
  './index.html',
  './styles.css',
  './db-helper.js',
  './app.js',
  './manifest.json'
];

// -------------------------------------------------------------------- ciclo

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_STATIC_NAME).then(function (cache) {
      return cache.addAll(STATIC_FILES);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (nombres) {
      return Promise.all(nombres.map(function (nombre) {
        if (nombre !== CACHE_STATIC_NAME) {
          return caches.delete(nombre);
        }
        return Promise.resolve(false);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// ---------------------------------------------------------------- app shell

self.addEventListener('fetch', function (event) {
  const peticion = event.request;

  // Los POST nunca se responden desde la cache: van a la red o a la cola.
  if (peticion.method !== 'GET') {
    return;
  }

  event.respondWith(
    caches.match(peticion).then(function (enCache) {
      if (enCache) {
        return enCache;
      }

      return fetch(peticion).then(function (respuesta) {
        if (respuesta && respuesta.status === 200 && respuesta.type === 'basic') {
          const copia = respuesta.clone();
          caches.open(CACHE_STATIC_NAME).then(function (cache) {
            cache.put(peticion, copia);
          });
        }
        return respuesta;
      }).catch(function () {
        // Navegacion sin red: devolvemos el index cacheado.
        if (peticion.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return new Response('Recurso no disponible sin conexion', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      });
    })
  );
});

// ------------------------------------------------------------------- puente

/**
 * Avisa a todas las pestanas abiertas de la PWA que la cola se sincronizo.
 * Es la mitad "emisora" del puente postMessage <-> addEventListener('message').
 */
function notificarClientesActualizacion() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(function (clientes) {
      clientes.forEach(function (cliente) {
        cliente.postMessage({
          tipo: 'OUTBOX_SINCRONIZADO',
          timestamp: Date.now()
        });
      });
      return clientes.length;
    });
}

// --------------------------------------------------------------- sync motor

/**
 * Reenvia cada registro pendiente y actualiza su estado a 'sincronizado'.
 * Devuelve la cadena completa de promesas para que event.waitUntil() sepa
 * exactamente cuando termino el trabajo.
 */
function sincronizarPendientesSW() {
  console.log('[SW-Sync] Ejecutando barrido de transacciones pendientes...');

  return obtenerTodosLosRegistros()
    .then(function (registros) {
      const pendientes = registros.filter(function (item) {
        return item.estado === 'pendiente';
      });

      if (pendientes.length === 0) {
        console.log('[SW-Sync] Cola limpia. Nada por sincronizar.');
        return notificarClientesActualizacion();
      }

      const promesasDeEnvio = pendientes.map(function (item) {
        return fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: item.titulo,
            body: item.descripcion
          })
        }).then(function (respuesta) {
          if (!respuesta.ok) {
            throw new Error('Error HTTP ' + respuesta.status +
              ' al sincronizar ID ' + item.id);
          }
          return actualizarEstadoRegistro(item.id, 'sincronizado');
        });
      });

      return Promise.all(promesasDeEnvio)
        .then(function () {
          console.log('[SW-Sync] Cola enviada:', pendientes.length, 'registro(s).');
          return notificarClientesActualizacion();
        });
    });
}

self.addEventListener('sync', function (event) {
  console.log('[SW-Sync] Evento sync disparado con etiqueta:', event.tag);

  if (event.tag === 'sync-reportes') {
    event.waitUntil(
      sincronizarPendientesSW().catch(function (error) {
        console.error('[SW-Sync] Falla en sincronizacion; el navegador reintentara luego:', error);
        // Relanzar el error indica al navegador que debe programar un reintento.
        throw error;
      })
    );
  }
});

// Sincronizacion pedida a mano desde la interfaz (boton "Sincronizar ahora").
self.addEventListener('message', function (event) {
  const datos = event.data || {};

  if (datos.tipo === 'FORZAR_SYNC' && event.waitUntil) {
    event.waitUntil(sincronizarPendientesSW().catch(function (error) {
      console.error('[SW-Sync] Error en sync manual:', error);
    }));
  }
});
