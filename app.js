'use strict';

const ENDPOINT = 'https://jsonplaceholder.typicode.com/posts';
const TAG = 'sync-reportes';

function $(id) { return document.getElementById(id); }

function estado(msg, ok) {
  const b = $('badge-red');
  if (!b) return;
  b.className = 'dot ' + (ok ? 'online' : 'offline');
  b.title = msg;
}

function esc(t) {
  return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

function hora(ts) {
  const d = new Date(ts);
  return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + ' ' +
    ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

function fila(r) {
  const p = r.estado === 'sincronizado' ? 'sincronizado' : 'pendiente';
  const x = r.estado === 'sincronizado' ? '<button class="btn-mini" data-eliminar="' + r.id + '">×</button>' : '';
  return '<tr><td class="col-id">' + r.id + '</td><td>' + esc(r.titulo) + '</td>' +
    '<td class="col-estado"><span class="pastilla ' + p + '">' + r.estado + '</span></td>' +
    '<td class="col-hora">' + hora(r.fechaCreacion) + '</td><td>' + x + '</td></tr>';
}

function render() {
  return obtenerTodosLosRegistros().then(function (rs) {
    rs.sort(function (a, b) { return (b.fechaCreacion || 0) - (a.fechaCreacion || 0); });
    $('lista-outbox').innerHTML = rs.length ? rs.map(fila).join('') :
      '<tr><td colspan="5" class="vacio">Sin registros todavía.</td></tr>';
    $('badge-pendientes').textContent = rs.filter(function (r) { return r.estado === 'pendiente'; }).length;
    return rs;
  });
}

function guardar(datos, nombreEstado) {
  return guardarRegistro({
    titulo: datos.titulo,
    descripcion: datos.descripcion,
    estado: nombreEstado,
    fechaCreacion: Date.now(),
    intentos: 0
  });
}

function procesar(datos) {
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(datos)
  })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return guardar(datos, 'sincronizado');
    })
    .catch(function () {
      return guardar(datos, 'pendiente').then(function (id) {
        registrarSync();
        return id;
      });
    })
    .then(render);
}

function registrarSync() {
  if (!('serviceWorker' in navigator) || !('SyncManager' in window)) return Promise.resolve(false);
  return navigator.serviceWorker.ready
    .then(function (reg) { return reg.sync.register(TAG); })
    .catch(function () { return false; });
}

function sincronizar() {
  return obtenerTodosLosRegistros().then(function (rs) {
    const pend = rs.filter(function (r) { return r.estado === 'pendiente'; });
    return Promise.all(pend.map(function (r) {
      return fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: r.titulo, body: r.descripcion })
      })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return actualizarEstadoRegistro(r.id, 'sincronizado');
        })
        .catch(function () { return incrementarIntentos(r.id); });
    }));
  }).then(render);
}

function purgar() {
  return obtenerTodosLosRegistros().then(function (rs) {
    const ids = rs.filter(function (r) { return r.estado === 'sincronizado'; })
      .map(function (r) { return r.id; });
    return Promise.all(ids.map(eliminarRegistro));
  }).then(render);
}

function alEnviar(e) {
  e.preventDefault();
  const datos = { titulo: $('titulo').value.trim(), descripcion: $('descripcion').value.trim() };
  if (!datos.titulo || !datos.descripcion) { estado('Faltan datos obligatorios', false); return; }
  const b = $('btn-enviar');
  b.disabled = true;
  procesar(datos)
    .then(function () { $('form-incidencia').reset(); estado('Reporte procesado', true); })
    .catch(function (err) { estado('Error: ' + err.message, false); })
    .finally(function () { b.disabled = false; });
}

function iniciar() {
  estado(navigator.onLine ? 'En línea' : 'Sin conexión', navigator.onLine);
  $('form-incidencia').addEventListener('submit', alEnviar);
  $('btn-sincronizar').addEventListener('click', function () {
    sincronizar().catch(function (e) { estado(e.message, false); });
  });
  $('btn-purgar').addEventListener('click', function () {
    purgar().catch(function (e) { estado(e.message, false); });
  });
  $('lista-outbox').addEventListener('click', function (e) {
    const b = e.target.closest('[data-eliminar]');
    if (b) eliminarRegistro(Number(b.getAttribute('data-eliminar'))).then(render);
  });
  window.addEventListener('online', function () {
    estado('En línea', true);
    if (!('SyncManager' in window)) sincronizar().catch(function () {});
  });
  window.addEventListener('offline', function () { estado('Sin conexión', false); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(function () {});
  abrirDB().then(render).catch(function (e) { estado('Error de base: ' + e.message, false); });
}

document.addEventListener('DOMContentLoaded', iniciar);
