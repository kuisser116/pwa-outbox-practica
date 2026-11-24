'use strict';

const CACHE = 'static-outbox-v2';
const ENDPOINT = 'https://jsonplaceholder.typicode.com/posts';
const FILES = ['./', './index.html', './styles.css', './db-helper.js', './app.js', './manifest.json'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ns) {
    return Promise.all(ns.map(function (n) { return n !== CACHE ? caches.delete(n) : Promise.resolve(false); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  const p = e.request;
  if (p.method !== 'GET') return;
  e.respondWith(caches.match(p).then(function (c) {
    if (c) return c;
    return fetch(p).then(function (r) {
      if (r && r.status === 200 && r.type === 'basic') {
        const cp = r.clone();
        caches.open(CACHE).then(function (cache) { cache.put(p, cp); });
      }
      return r;
    }).catch(function () {
      if (p.mode === 'navigate') return caches.match('./index.html');
      return new Response('Sin conexión', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    });
  }));
});

function avisar() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
    cs.forEach(function (c) { c.postMessage({ tipo: 'OUTBOX_SINCRONIZADO', timestamp: Date.now() }); });
    return cs.length;
  });
}

function sincronizar() {
  return obtenerTodosLosRegistros().then(function (rs) {
    const ps = rs.filter(function (r) { return r.estado === 'pendiente'; });
    if (!ps.length) return avisar();
    return Promise.all(ps.map(function (r) {
      return fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: r.titulo, body: r.descripcion })
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return actualizarEstadoRegistro(r.id, 'sincronizado');
      });
    })).then(avisar);
  });
}

self.addEventListener('sync', function (e) {
  if (e.tag === 'sync-reportes') e.waitUntil(sincronizar().catch(function (err) { throw err; }));
});

self.addEventListener('message', function (e) {
  if (e.data && e.data.tipo === 'FORZAR_SYNC' && e.waitUntil) e.waitUntil(sincronizar().catch(function () {}));
});
