/*
 * app.js
 * Logica de interfaz, envio resiliente (patron Outbox) y reconexion.
 *
 * Toda la asincronia se maneja con new Promise(), .then(), .catch() y
 * Promise.all(). Sin librerias externas y sin funciones asincronas modernas.
 *
 * Las funciones de este archivo son globales a proposito: la guia las invoca
 * por nombre (renderizarColaOutbox, procesarEnvioReporte, etc.) y el Service
 * Worker se comunica con ellas por mensajes.
 */

'use strict';

const ENDPOINT = 'https://jsonplaceholder.typicode.com/posts';
const SYNC_TAG = 'sync-reportes';

// ---------------------------------------------------------------- utilidades

function $(id) {
  return document.getElementById(id);
}

function fechaCorta(marca) {
  if (!marca) {
    return '—';
  }
  const d = new Date(marca);
  return ('0' + d.getDate()).slice(-2) + '/' +
    ('0' + (d.getMonth() + 1)).slice(-2) + ' ' +
    ('0' + d.getHours()).slice(-2) + ':' +
    ('0' + d.getMinutes()).slice(-2);
}

function escapar(texto) {
  return String(texto === undefined || texto === null ? '' : texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function anotar(mensaje) {
  const lista = $('bitacora');
  const item = document.createElement('li');
  const ahora = new Date();

  item.textContent = ('0' + ahora.getHours()).slice(-2) + ':' +
    ('0' + ahora.getMinutes()).slice(-2) + ':' +
    ('0' + ahora.getSeconds()).slice(-2) + '  ' + mensaje;

  lista.insertBefore(item, lista.firstChild);

  const ultimo = $('ultimo-aviso');
  if (ultimo) {
    ultimo.textContent = mensaje;
  }

  while (lista.children.length > 60) {
    lista.removeChild(lista.lastChild);
  }
}

// ------------------------------------------------------------------- la red

function actualizarIndicadorRed() {
  const badge = $('badge-red');
  const enLinea = navigator.onLine;

  badge.className = 'dot ' + (enLinea ? 'online' : 'offline');
  badge.title = enLinea ? 'En linea' : 'Sin conexion';
  badge.setAttribute('aria-label', badge.title);
}

// ------------------------------------------------------------------- pintado

function filaHtml(registro) {
  const clase = registro.estado === 'sincronizado' ? 'sincronizado' : 'pendiente';
  const detalle = escapar(registro.descripcion) +
    (registro.intentos ? '  ·  intentos: ' + registro.intentos : '');
  const boton = registro.estado === 'sincronizado'
    ? '<button class="btn-mini" data-eliminar="' + registro.id + '" title="Quitar" aria-label="Quitar">' +
      '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>' +
      '</button>'
    : '';

  return '<tr>' +
    '<td class="col-id">' + registro.id + '</td>' +
    '<td title="' + detalle + '">' + escapar(registro.titulo) + '</td>' +
    '<td class="col-estado"><span class="pastilla ' + clase + '">' + registro.estado + '</span></td>' +
    '<td class="col-hora">' + fechaCorta(registro.fechaCreacion) + '</td>' +
    '<td class="col-accion">' + boton + '</td>' +
    '</tr>';
}

/**
 * READ de la interfaz: lee IndexedDB y dibuja la cola completa.
 */
function renderizarColaOutbox() {
  return obtenerTodosLosRegistros().then(function (registros) {
    const cuerpo = $('lista-outbox');

    registros.sort(function (a, b) {
      return (b.fechaCreacion || 0) - (a.fechaCreacion || 0);
    });

    if (registros.length === 0) {
      cuerpo.innerHTML = '<tr><td colspan="5" class="vacio">Sin registros todavia.</td></tr>';
      actualizarBadgePendientes(0);
      return registros;
    }

    cuerpo.innerHTML = registros.map(filaHtml).join('');

    const pendientes = registros.filter(function (item) {
      return item.estado === 'pendiente';
    }).length;

    actualizarBadgePendientes(pendientes);
    return registros;
  }).catch(function (error) {
    console.error('[Outbox] Error al leer la cola:', error);
    anotar('Error al leer la cola: ' + error.message);
  });
}

function actualizarBadgePendientes(pendientes) {
  const badge = $('badge-pendientes');
  badge.textContent = String(pendientes);
  badge.title = pendientes + (pendientes === 1 ? ' pendiente' : ' pendientes');
  badge.style.opacity = pendientes > 0 ? '1' : '0.55';
}

// ------------------------------------------------------------------ el envio

/**
 * CREATE con fallback: intenta el POST. Si hay red y el servidor confirma,
 * guarda el registro como 'sincronizado'. Si falla (sin red, red caida o
 * error HTTP), el .catch() lo encola como 'pendiente' y delega el reenvio al
 * Service Worker con la etiqueta 'sync-reportes'.
 */
function procesarEnvioReporte(datosFormulario) {
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(datosFormulario)
  })
    .then(function (respuesta) {
      if (!respuesta.ok) {
        throw new Error('Error HTTP del servidor: ' + respuesta.status);
      }
      return respuesta.json();
    })
    .then(function () {
      // Envio exitoso en vivo: bitacora local como 'sincronizado'
      return guardarRegistro({
        titulo: datosFormulario.titulo,
        descripcion: datosFormulario.descripcion,
        estado: 'sincronizado',
        fechaCreacion: Date.now(),
        intentos: 0
      }).then(function (id) {
        console.log('[Outbox] Enviado y guardado como sincronizado. ID:', id);
        anotar('Enviado al servidor y guardado como "sincronizado" (id ' + id + ').');
      });
    })
    .catch(function (error) {
      console.warn('[Outbox] Sin conexion o fallo del servidor. Encolando localmente...', error.message);

      return guardarRegistro({
        titulo: datosFormulario.titulo,
        descripcion: datosFormulario.descripcion,
        estado: 'pendiente',
        fechaCreacion: Date.now(),
        intentos: 0
      }).then(function (id) {
        anotar('Sin red: guardado como "pendiente" (id ' + id + ').');
        return registrarSync();
      });
    })
    .then(function () {
      // Actualizar la lista visual en ambos escenarios
      return renderizarColaOutbox();
    });
}

/**
 * Registra la etiqueta de Background Sync. El navegador queda encargado del
 * reenvio incluso si el usuario cierra la pestana.
 */
function registrarSync() {
  if (!('serviceWorker' in navigator) || !('SyncManager' in window)) {
    anotar('Este navegador no tiene SyncManager: se usara el fallback del evento online.');
    return Promise.resolve(false);
  }

  return navigator.serviceWorker.ready.then(function (registro) {
    console.log('[Outbox] Registrando etiqueta sync-reportes en el SW...');
    anotar('Registrando la etiqueta "' + SYNC_TAG + '" en el Service Worker.');
    return registro.sync.register(SYNC_TAG);
  }).then(function () {
    anotar('Tarea de sincronizacion registrada: el navegador reintentara solo.');
    return true;
  }).catch(function (error) {
    console.error('[Outbox] No se pudo registrar el sync:', error);
    anotar('No se pudo registrar el sync: ' + error.message);
    return false;
  });
}

/**
 * UPDATE de respaldo: barrido y reenvio de pendientes desde el hilo principal.
 * Solo se usa en navegadores sin Background Sync (Safari/iOS, Firefox) o
 * cuando el usuario pulsa "Sincronizar ahora".
 */
function sincronizarPendientesFallback() {
  console.log('[Outbox] Conexion detectada. Buscando registros pendientes...');

  return obtenerTodosLosRegistros()
    .then(function (registros) {
      const pendientes = registros.filter(function (item) {
        return item.estado === 'pendiente';
      });

      if (pendientes.length === 0) {
        console.log('[Outbox] No hay transacciones pendientes por sincronizar.');
        anotar('No hay pendientes por reenviar.');
        return [];
      }

      anotar('Reenviando ' + pendientes.length + ' pendiente(s) con Promise.all()...');

      // Cada registro pendiente se convierte en una promesa HTTP + UPDATE
      const promesasDeEnvio = pendientes.map(function (item) {
        return fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: item.titulo, body: item.descripcion })
        }).then(function (respuesta) {
          if (!respuesta.ok) {
            throw new Error('Falla al reintentar envio del ID ' + item.id);
          }
          return actualizarEstadoRegistro(item.id, 'sincronizado').then(function () {
            return { id: item.id, ok: true };
          });
        }).catch(function (error) {
          return incrementarIntentos(item.id).then(function () {
            return { id: item.id, ok: false, detalle: error.message };
          });
        });
      });

      // Esperar a que todos los reenvios concluyan
      return Promise.all(promesasDeEnvio);
    })
    .then(function (resultados) {
      if (resultados.length > 0) {
        const exitos = resultados.filter(function (r) { return r.ok; }).length;
        anotar('Resultado: ' + exitos + ' sincronizado(s), ' +
          (resultados.length - exitos) + ' con error.');
      }
      return renderizarColaOutbox().then(function () {
        return resultados;
      });
    })
    .catch(function (error) {
      console.error('[Outbox] Error durante la sincronizacion masiva:', error);
      anotar('Error en la sincronizacion: ' + error.message);
    });
}

// -------------------------------------------------------------- DELETE y UI

/**
 * DELETE: purga los registros ya sincronizados (Promise.all de eliminaciones).
 */
function purgarEnviados() {
  return obtenerTodosLosRegistros().then(function (registros) {
    const sincronizados = registros.filter(function (item) {
      return item.estado === 'sincronizado';
    });

    if (sincronizados.length === 0) {
      anotar('No hay registros sincronizados que purgar.');
      return renderizarColaOutbox();
    }

    const promesasDeBorrado = sincronizados.map(function (item) {
      return eliminarRegistro(item.id);
    });

    return Promise.all(promesasDeBorrado).then(function () {
      console.log('[Outbox] Purgados', sincronizados.length, 'registros sincronizados.');
      anotar('Purgados ' + sincronizados.length + ' registro(s) ya sincronizados.');
      return renderizarColaOutbox();
    });
  }).catch(function (error) {
    console.error('[Outbox] Error al purgar:', error);
    anotar('Error al purgar: ' + error.message);
  });
}

function quitarRegistro(id) {
  return eliminarRegistro(id).then(function () {
    anotar('Registro ' + id + ' eliminado de la cola.');
    return renderizarColaOutbox();
  }).catch(function (error) {
    anotar('Error al eliminar el registro: ' + error.message);
  });
}

// ------------------------------------------------------------------ eventos

function alEnviarFormulario(evento) {
  evento.preventDefault();

  const datos = {
    titulo: $('titulo').value.trim(),
    descripcion: $('descripcion').value.trim()
  };

  if (!datos.titulo || !datos.descripcion) {
    anotar('Faltan datos obligatorios en el formulario.');
    return;
  }

  const boton = $('btn-enviar');
  boton.disabled = true;

  procesarEnvioReporte(datos).then(function () {
    $('form-incidencia').reset();
  }).catch(function (error) {
    anotar('No se pudo procesar el reporte: ' + error.message);
  }).then(function () {
    boton.disabled = false;
  });
}

function alRecibirMensajeDelSW(evento) {
  const datos = evento.data || {};

  if (datos.tipo === 'OUTBOX_SINCRONIZADO') {
    console.log('[UI] Confirmacion recibida del Service Worker. Actualizando bandeja...');
    anotar('El Service Worker sincronizo la cola en segundo plano.');
    renderizarColaOutbox();
  }
}

function alVolverLaRed() {
  actualizarIndicadorRed();

  // Degradacion elegante: solo sincroniza la UI si NO hay Background Sync.
  if (!('SyncManager' in window)) {
    console.log('[Outbox] Navegador sin SyncManager. Ejecutando fallback por evento online...');
    sincronizarPendientesFallback();
  } else {
    anotar('Red de vuelta: el reenvio corre en segundo plano (Background Sync).');
  }
}

// ------------------------------------------------------------ service worker

function registrarServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    anotar('Este navegador no soporta Service Workers.');
    return;
  }

  navigator.serviceWorker.register('./sw.js').then(function (registro) {
    anotar('Service Worker registrado (alcance: ' + registro.scope + ').');
  }).catch(function (error) {
    console.error('[Outbox] Fallo al registrar el Service Worker:', error);
    anotar('Fallo al registrar el Service Worker: ' + error.message);
  });

  navigator.serviceWorker.addEventListener('message', alRecibirMensajeDelSW);
}

// -------------------------------------------------------------------- inicio

function iniciar() {
  actualizarIndicadorRed();

  window.addEventListener('online', alVolverLaRed);
  window.addEventListener('offline', function () {
    actualizarIndicadorRed();
    anotar('Sin conexion: los envios se guardaran en la cola.');
  });

  $('form-incidencia').addEventListener('submit', alEnviarFormulario);

  $('btn-sincronizar').addEventListener('click', function () {
    sincronizarPendientesFallback();
  });

  $('btn-purgar').addEventListener('click', purgarEnviados);

  $('lista-outbox').addEventListener('click', function (evento) {
    const id = evento.target.getAttribute('data-eliminar');
    if (id) {
      quitarRegistro(Number(id));
    }
  });

  registrarServiceWorker();

  abrirDB().then(function () {
    anotar('Base pwa-outbox-db / transacciones_pendientes lista.');
    return renderizarColaOutbox();
  }).then(function () {
    if ('SyncManager' in window) {
      anotar('SyncManager disponible: la cola se reenviara sola en segundo plano.');
    } else {
      anotar('Sin SyncManager: se usara el evento online como respaldo.');
    }
  }).catch(function (error) {
    anotar('Error al abrir la base de datos: ' + error.message);
  });
}

document.addEventListener('DOMContentLoaded', iniciar);
