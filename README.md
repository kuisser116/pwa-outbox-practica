# pwa-outbox-practica

Registro de incidencias de campo con **persistencia offline** en IndexedDB,
**patron Outbox** y **sincronizacion en segundo plano** con la Background Sync API.

Materia: Desarrollo de Aplicaciones Web Progresivas (PWA)
Temas cubiertos: 5.1 Persistencia estructurada · 5.2 Patron Outbox · 5.3 Background Sync

App publicada: https://kuisser116.github.io/pwa-outbox-practica/

---

## Reglas del curso que cumple el proyecto

| Restriccion | Como se cumple |
|---|---|
| 100% JavaScript Vanilla | Sin dependencias, sin CDN y sin build. Tres scripts planos: `db-helper.js`, `app.js`, `sw.js`. |
| Interfaz asincrona solo con Promesas | Toda la asincronia usa `new Promise()`, `.then()`, `.catch()` y `Promise.all()`. |
| Sin librerias de IndexedDB | El wrapper esta escrito sobre la API nativa: `indexedDB.open`, `transaction`, `objectStore`. |
| Rutas relativas para GitHub Pages | `./styles.css`, `./sw.js`, `"./index.html"` en el manifest y `scope: "./"`. Nunca una diagonal inicial. |
| HTTPS | GitHub Pages sirve por HTTPS, requisito para que exista `navigator.serviceWorker`. |

## Estructura

```
pwa-outbox-practica/
├── index.html       Interfaz: formulario de incidencias y bandeja de salida
├── styles.css       Tema oscuro responsive
├── db-helper.js     Mini-wrapper promisificado de IndexedDB (compartido con el SW)
├── app.js           UI, envio resiliente y reconexion
├── sw.js            App Shell en Cache API + motor de Background Sync
├── manifest.json    Manifiesto configurado para subdirectorio
├── icon.svg         Icono vectorial
├── icon-192.png     Iconos requeridos por el manifest
└── icon-512.png
```

`db-helper.js` se carga **antes** que `app.js` y deja sus funciones en el ambito
global (`guardarRegistro`, `obtenerTodosLosRegistros`, ...). Dentro del Service
Worker entra con `importScripts('./db-helper.js')`.

## Base de datos

```
pwa-outbox-db  (version 1)
└── transacciones_pendientes   keyPath: "id" (autoIncrement)
                               indices: "por_fecha" (fechaCreacion) y "por_estado" (estado)
└── catalogo                   keyPath: "sku"
```

Las Object Store **solo** se crean dentro de `onupgradeneeded`; fuera de ese
evento el navegador lanza `InvalidStateError`. Cada operacion abre una
transaccion `readonly` (lecturas) o `readwrite` (escrituras).

| Funcion | CRUD | Que hace |
|---|---|---|
| `abrirDB()` | — | Promesa con `IDBDatabase`; crea el esquema en `onupgradeneeded`. |
| `guardarRegistro(datos)` | CREATE | `store.add()` y resuelve el id en `tx.oncomplete` (no en `req.onsuccess`). |
| `obtenerTodosLosRegistros()` | READ | `store.getAll()` en transaccion `readonly`. |
| `actualizarEstadoRegistro(id, estado)` | UPDATE | `store.get(id)` y, dentro de su `onsuccess`, `store.put(registro)` en la misma transaccion. |
| `incrementarIntentos(id)` | UPDATE | Suma un intento fallido sin cambiar el estado. |
| `eliminarRegistro(id)` | DELETE | `store.delete(id)`. |

## Flujo del patron Outbox

```
Usuario envia el formulario (POST)
  |
  +-- Hay red y el servidor responde 2xx --> guarda como 'sincronizado'
  |
  +-- Sin red, red caida o error HTTP (.catch)
        --> CREATE: guarda como 'pendiente'
        --> reg.sync.register('sync-reportes')
              (el navegador reintenta aunque cierres la pestana)

Al cargar la pagina        --> READ: dibuja la cola completa
Evento 'online'            --> fallback con Promise.all, solo si NO hay SyncManager
Evento 'sync' en el SW     --> UPDATE: reenvia y marca 'sincronizado'
Boton "Purgar Sincronizados" --> DELETE: borra los ya sincronizados
```

El Service Worker no puede tocar el DOM, asi que termina avisando con
`clients.matchAll()` + `postMessage({ tipo: 'OUTBOX_SINCRONIZADO' })`, y
`app.js` escucha `addEventListener('message', ...)` para repintar la tabla.

## Como probarlo

1. Envia un reporte con red: queda como **sincronizado**.
2. DevTools → Network → **Offline** y envia otro: queda **pendiente** y se
   registra la etiqueta `sync-reportes`.
3. DevTools → Application → IndexedDB → `pwa-outbox-db` → `transacciones_pendientes`:
   ahi esta el registro con `estado: "pendiente"`.
4. DevTools → Application → Service Workers → **Sync**, o pulsa
   "Sincronizar ahora": el registro pasa a **sincronizado**.
5. "Purgar Sincronizados" borra los sincronizados.

Prueba de la pestana cerrada: DevTools → Network → **Offline**, envia dos
reportes, comprueba en **Application → Background Sync** la etiqueta
`sync-reportes`, cierra la pestana, vuelve a conectar y abre la URL: el
navegador dispara el evento `sync` y la cola se vacia sola.

El corte de red se simula con DevTools (Network → Offline) o desconectando el
equipo: la app no incluye un interruptor artificial para eso.

## Respuestas para la defensa oral

**Diferencia entre `req.onsuccess` y `tx.oncomplete` en `guardarRegistro`.**
`req.onsuccess` solo indica que el motor acepto la operacion y entrego el id;
la transaccion aun puede abortar. `tx.oncomplete` confirma que la escritura se
confirmo en disco, por eso la promesa resuelve ahi.

**Agregar un Object Store sin subir `DB_VERSION`.**
No ocurre nada: `onupgradeneeded` no se dispara, el store nuevo no existe y
cualquier transaccion sobre el lanza `NotFoundError`.

**Quitar el `return` antes de `new Promise()` en `guardarRegistro`.**
La promesa interna se crea pero no se devuelve, asi que el `.then()` externo
recibe `undefined` y la cadena se rompe: no se puede encadenar la lectura.

**Como carga `db-helper.js` dentro de `sw.js`.**
Con `importScripts('./db-helper.js')`, la unica via de los Service Workers
clasicos, que no tienen acceso a etiquetas `<script>` del DOM.

**Por que no se puede llamar `renderizarColaOutbox()` desde `sw.js`.**
El SW corre en otro hilo sin DOM. El puente son dos mitades:
`clients.matchAll()` + `postMessage()` en `sw.js`, y
`addEventListener('message')` en `app.js`.

**Que provoca `throw error` dentro del evento `sync`.**
Relanzar el error le avisa al navegador que la tarea fallo, y este la
reprograma para reintentar cuando vuelva la conectividad. Con solo
`console.error()` el navegador consideraria la tarea completada y no reintenta.

**Por que el evento `online` se condiciona con `!('SyncManager' in window)`.**
Para evitar una condicion de carrera: si corrieran a la vez, `app.js` y `sw.js`
leerian la misma cola y enviarian los POST duplicados.

**Que pasaria con `register('/sw.js')` en vez de `register('./sw.js')`.**
Con la diagonal inicial el navegador buscaria `https://kuisser116.github.io/sw.js`
(la raiz del dominio), no la carpeta del repositorio: daria 404, el SW no se
instalaria y se perderia el modo offline.
