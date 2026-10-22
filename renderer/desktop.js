// ============================================================
// SimSys OS — escritorio: gestor de ventanas, arranque,
// barra de tareas, menú de inicio y bucle del núcleo
// ============================================================
'use strict';

/* ==================== instancia del núcleo ==================== */
const OS = {
  kernel: new Kernel(),
  timer: null,
  tickTimerCache: null,
  toast(msg, cls = '') {
    const t = el('div', 'toast ' + cls, msg);
    $('#toast-stack').appendChild(t);
    setTimeout(() => t.remove(), 4200);
  },
  pause(pause) {
    OS.kernel.paused = pause;
    $('#play-btn').textContent = pause ? '▶' : '⏸';
  },
  restartTimer() {
    clearInterval(OS.timer);
    OS.timer = setInterval(() => {
      if (OS.kernel.paused) return;
      OS.kernel.tick();
    }, OS.kernel.cfg.tickMs);
  },
};

/* ===================== gestor de ventanas ===================== */
const WM = {
  wins: new Map(), // appId -> {win, appId}
  zTop: 100,
  open(appId) {
    const appDef = Apps.find((a) => a.id === appId || a.name === appId) || Apps.find((a) => a.icon === appId);
    if (!appDef) {
      console.warn('app no encontrada', appId);
      return;
    }
    if (appDef.isWeb) {
      appDef.launch();
      return;
    }
    if (WM.wins.has(appDef.name)) {
      const w = WM.wins.get(appDef.name);
      wmFocus(w);
      if (w.minimized) wmToggleMin(w);
      return;
    }
    const n = el('div', 'window');
    n.style.width = Math.min(appDef.w, innerWidth - 60) + 'px';
    n.style.height = Math.min(appDef.h, innerHeight - 100) + 'px';
    n.style.left = 60 + Math.random() * Math.max(30, innerWidth - appDef.w - 120) + 'px';
    n.style.top = 30 + Math.random() * Math.max(20, innerHeight - appDef.h - 160) + 'px';
    n.innerHTML = `
      <div class="titlebar">
        <span class="t-icon">${appDef.icon}</span>
        <span class="t-title">${appDef.name}</span>
        <button class="window-btn" data-min>—</button>
        <button class="window-btn" data-max>▢</button>
        <button class="window-btn close" data-close>✕</button>
      </div>
      <div class="win-body"></div>
      <div class="resize-handle"></div>`;
    $('#windows-layer').appendChild(n);
    const body = n.querySelector('.win-body');

    const win = {
      root: n,
      minimized: false,
      appId: appDef.name,
      close: () => wmClose(win),
      onClick: [],
      _tickSubs: [],
      onTick(fn) {
        win._tickSubs.push(fn);
        try { fn(); } catch (err) { console.error(err); }
      },
    };
    WM.wins.set(appDef.name, win);
    wmFocus(win);
    appDef.launch(body, win);
    wmRenderTasks();

    n.addEventListener('mousedown', () => wmFocus(win));
    n.querySelector('[data-close]').addEventListener('click', () => win.close());
    n.querySelector('[data-min]').addEventListener('click', () => wmToggleMin(win));
    n.querySelector('[data-max]').addEventListener('click', () => wmToggleMax(win));
    wmDrag(n, n.querySelector('.titlebar'), () => win);
    wmResize(n, n.querySelector('.resize-handle'));
    return win;
  },
};

function wmFocus(w) {
  WM.zTop++;
  w.root.style.zIndex = WM.zTop;
  for (const x of WM.wins.values()) x.root.classList.toggle('focused', x === w);
  wmRenderTasks();
}
function wmClose(w) {
  try {
    const app = Apps.find((a) => a.name === w.appId);
    app?.onClose?.(w);
  } catch (_) {}
  w.root.remove();
  WM.wins.delete(w.appId);
  wmRenderTasks();
}
function wmToggleMin(w) {
  w.minimized = !w.minimized;
  // simplement oculta e inactiva: display:none la saca del flujo de
  // interacción (ni clics ni foco), y no conserva el estado "focused"
  w.root.classList.toggle('minimized', w.minimized);
  w.root.style.display = w.minimized ? 'none' : '';
  if (w.minimized) {
    w.root.classList.remove('focused');
    const next = [...WM.wins.values()].filter((x) => x !== w && !x.minimized)
      .sort((a, b) => (+b.root.style.zIndex) - (+a.root.style.zIndex))[0];
    if (next) wmFocus(next);
  }
  wmRenderTasks();
}
function wmToggleMax(w) {
  w.root.classList.toggle('maximized');
  if (w.root.classList.contains('maximized')) {
    w.root.dataset.prev = JSON.stringify([w.root.style.left, w.root.style.top, w.root.style.width, w.root.style.height]);
    Object.assign(w.root.style, { left: '0px', top: '0px', width: '100%', height: `calc(100% - 52px)` });
  } else if (w.root.dataset.prev) {
    const [l, t, wi, he] = JSON.parse(w.root.dataset.prev);
    Object.assign(w.root.style, { left: l, top: t, width: wi, height: he });
  }
}
function wmDrag(root, handle, winref) {
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  handle.addEventListener('mousedown', (e) => {
    if (root.classList.contains('maximized')) return;
    dragging = true;
    sx = e.clientX; 
    sy = e.clientY;
    ox = root.offsetLeft; 
    oy = root.offsetTop;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    root.style.left = Math.max(-80, ox + e.clientX - sx) + 'px';
    root.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
  });
  window.addEventListener('mouseup', () => (dragging = false));
}
function wmResize(root, handle) {
  let active = false, sx = 0, sy = 0, w0 = 0, h0 = 0;
  handle.addEventListener('mousedown', (e) => {
    active = true; sx = e.clientX; sy = e.clientY;
    w0 = root.offsetWidth; h0 = root.offsetHeight;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!active) return;
    root.style.width = Math.max(380, w0 + e.clientX - sx) + 'px';
    root.style.height = Math.max(260, h0 + e.clientY - sy) + 'px';
  });
  window.addEventListener('mouseup', () => (active = false));
}
function wmRenderTasks() {
  const host = $('#task-items');
  host.innerHTML = '';
  for (const w of WM.wins.values()) {
    const app = Apps.find((a) => a.name === w.appId);
    const t = el('div', 'task-item' + (w.root.classList.contains('focused') && !w.minimized ? ' active' : '') + (w.minimized ? ' mini' : ''),
      `<span>${app ? app.icon : '🪟'}</span><span class="task-label">${w.appId}</span><button class="task-close" title="Cerrar ${w.appId}">✕</button>`);
    t.title = w.minimized
      ? `${w.appId} — minimizada · clic para restaurar · hover ✕ o clic derecho para cerrar`
      : `${w.appId} · hover ✕ o clic derecho para cerrar`;
    t.onclick = () => {
      if (w.minimized) { wmToggleMin(w); wmFocus(w); }
      else if (w.root.classList.contains('focused')) wmToggleMin(w);
      else wmFocus(w);
    };
    t.querySelector('.task-close').addEventListener('click', (e) => {
      e.stopPropagation();
      wmClose(w);
    });
    t.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openCtxMenu(e, [
        [w.minimized ? '⬆️ Restaurar' : '⬇️ Minimizar', () => (w.minimized ? (wmToggleMin(w), wmFocus(w)) : wmToggleMin(w))],
        [' ▬▬▬ ', null],
        ['✕ Cerrar ventana', () => wmClose(w)],
      ]);
    });
    host.appendChild(t);
  }
}

/* ===================== menú de inicio e iconos ===================== */
function buildMenus() {
  const list = $('#start-menu-list');
  list.innerHTML = '';
  for (const a of Apps) {
    const it = el('div', 'sm-item', `<span class="emoji">${a.icon}</span><span>${a.name}${a.isWeb ? ' <small style="color:var(--muted)">(web)</small>' : ''}</span>`);
    it.onclick = () => { $('#start-menu').classList.add('hidden'); WM.open(a.name); };
    list.appendChild(it);
  }
  // iconos del escritorio
  const icons = $('#desktop-icons');
  icons.innerHTML = '';
  for (const a of Apps.filter((x) => !x.isWeb || true).slice(0, 10)) {
    const d = el('div', 'desk-icon', `<span class="emoji">${a.icon}</span><span>${a.name}</span>`);
    d.title = a.name;
    d.ondblclick = () => WM.open(a.name);
    d.onclick = () => {
      document.querySelectorAll('.desk-icon').forEach((x) => x.classList.remove('selected'));
      d.classList.add('selected');
    };
    icons.appendChild(d);
  }
  // menú contextual del escritorio (ítems por defecto)
  const ctx = $('#ctx-menu');
  ctx.innerHTML = '';
  const entries = desktopCtxEntries();
  for (const [label, fn] of entries) {
    if (!fn) { ctx.appendChild(el('div', 'ctx-sep')); continue; }
    const it = el('div', 'ctx-item', label);
    it.onclick = () => { ctx.classList.add('hidden'); fn(); };
    ctx.appendChild(it);
  }
}

/* Entradas por defecto del menú contextual del escritorio */
function desktopCtxEntries() {
  return [
    ['➕ Crear proceso', () => createProcessDialog()],
    ['🧹 Compactar memoria', () => { OS.kernel.compact(); OS.toast('🧹 memoria compactada'); }],
    ['🚨 Grafo de espera', () => showWaitGraph()],
    [' ▬▬▬ ', null],
    ['🔄 Actualizar escritorio', () => location.reload()],
  ];
}

/* Menú contextual genérico: abre el #ctx-menu con las entradas dadas
   (o con las del escritorio si se pasa null). Se reconstruye cada vez,
   así que no "gasta" el menú del escritorio. */
function openCtxMenu(e, items) {
  const ctx = $('#ctx-menu');
  const entries = items || desktopCtxEntries();
  ctx.innerHTML = '';
  for (const [label, fn] of entries) {
    if (!fn) { ctx.appendChild(el('div', 'ctx-sep')); continue; }
    const it = el('div', 'ctx-item', label);
    it.onclick = () => { ctx.classList.add('hidden'); fn(); };
    ctx.appendChild(it);
  }
  ctx.classList.remove('hidden');
  const r = ctx.getBoundingClientRect();
  ctx.style.left = Math.min(e.clientX, innerWidth - r.width - 8) + 'px';
  ctx.style.top = Math.min(e.clientY, innerHeight - r.height - 8) + 'px';
}

/* ===================== ciclo del núcleo y UI ===================== */
function startKernelLoop() {
  OS.kernel.cfg.tickMs = +OS.kernel.cfg.tickMs;
  OS.restartTimer();
  OS.pause(false);
}

function initClock() {
  setInterval(() => {
    $('#clock').textContent = new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }, 1000);
}

function initTaskbarActions() {
  $('#start-btn').onclick = (e) => {
    e.stopPropagation();
    $('#start-menu').classList.toggle('hidden');
  };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#start-menu') && !e.target.closest('#start-btn')) $('#start-menu').classList.add('hidden');
    if (!e.target.closest('#ctx-menu')) $('#ctx-menu').classList.add('hidden');
  });
  $('#play-btn').onclick = () => OS.pause(!OS.kernel.paused);
  $('#sm-shutdown').onclick = () => {
    $('#modal-layer').classList.remove('hidden');
    $('#modal-layer').innerHTML = `
      <div class="dialog">
        <div class="d-head">⏻ Apagar SimSys OS</div>
        <div class="d-body">¿Quieres finalizar la simulación y cerrar el sistema operativo simulado?</div>
        <div class="d-foot"><button onclick="window.close();document.body.innerHTML='<h2 style=padding:40px>Sistema apagado. Reinicia la aplicación.</h2>'">Apagar</button>
        <button id="sdn">Cancelar</button></div>
      </div>`;
    $('#sdn').onclick = () => { $('#modal-layer').classList.add('hidden'); $('#modal-layer').innerHTML = ''; };
  };
  // contextual (reconstruye y muestra el menú del escritorio)
  $('#desktop-icons').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openCtxMenu(e, null);
  });
}

/* =================== alerta de interbloqueo =================== */
let deadlockBanner = null;
function watchKernelEvents() {
  let lastLen = OS.kernel.log.length;
  setInterval(() => {
    const k = OS.kernel;
    const log = k.log;
    if (log.length !== lastLen) {
      // para no saturar la pantalla: máximo 1 aviso de inanición por cada 25 s
      // (se reevalúa dentro del bucle: ciclos con varios eventos solo pintan 1 toast)
      for (const e of log.slice(lastLen)) {
        if (e.type === 'DEADLOCK') OS.toast('🚨 ' + e.text, 'error');
        if (e.type === 'starve' && e.text.includes('INANICIÓN')) {
          const nowMs = Date.now();
          if (nowMs - (watchKernelEvents._lastStarveToast || 0) > 25000) {
            OS.toast('⭐ ' + e.text, 'warn');
            watchKernelEvents._lastStarveToast = nowMs;
          }
        }
      }
      lastLen = log.length;
    }
    // LED y banner
    const led = $('#tray-deadlock');
    led.classList.toggle('on-danger', k.deadlock.active);
    $('#tray-starve').classList.toggle('on-warn', k.metrics.starved > 0);
    $('#tray-kernel').textContent = `${k.paused ? '⏸ pausado' : `t=${k.ticks} CPU ${k.cpuLoad().toFixed(0)}%`}`;

    if (k.deadlock.active && !deadlockBanner) {
      deadlockBanner = el('div', 'deadlock-banner', `
        <div>🚨 <b>INTERBLOQUEO</b> entre procesos: <b>${k.deadlock.cycle.join(' ⇄ ')}</b><br>
        <small>espera circular de recursos — elige cómo resolverla</small></div>
        <div class="db-actions">
          <button id="db-resolve">Abortar víctima</button>
          <button id="db-detail">Ver grafo</button>
        </div>`);
      $('#desktop').appendChild(deadlockBanner);
      deadlockBanner.querySelector('#db-resolve').onclick = () => {
        OS.kernel.resolveDeadlock(null);
        OS.toast('✔ interbloqueo resuelto');
      };
      deadlockBanner.querySelector('#db-detail').onclick = () => showWaitGraph();
    } else if (!k.deadlock.active && deadlockBanner) {
      deadlockBanner.remove();
      deadlockBanner = null;
    }
  }, 350);
}

// refresco de ventanas abiertas en cada tick del núcleo
setInterval(() => {
  if (OS.kernel.paused) return;
  for (const w of WM.wins.values()) {
    for (const fn of w._tickSubs) {
      try { fn(); } catch (err) { console.error('UI error', err); }
    }
  }
}, 100); // las ventanas se refrescan 10 veces/s (independiente del tick del núcleo)

/* ===================== secuencia de arranque ===================== */
const BOOT_LINES = [
  'SimSys BIOS v2.4 — POST OK',
  'cargando kernel simulado…',
  'inicializando planificador Round-Robin (quantum por proceso)',
  'montando memoria: 512 MB en particiones dinámicas (compactación)',
  'registrando dispositivos: disco, impresoras ×2, escáner, cámara, red',
  'arrancando procesos del sistema (init, rtkernel, servicios)…',
  'configurando detección de interbloqueos e inanición',
  'listo. iniciando sesión gráfica…',
];

async function boot() {
  const logEl = $('#boot-log');
  const fill = $('#boot-bar-fill');
  OS.kernel.cfg.tickMs = 250;
  await new Promise((r) => setTimeout(r, 400));
  for (let i = 0; i < BOOT_LINES.length; i++) {
    logEl.textContent += `[ i ] ${BOOT_LINES[i]}\n`;
    fill.style.width = ((i + 1) / BOOT_LINES.length) * 100 + '%';
    await new Promise((r) => setTimeout(r, 180 + Math.random() * 160));
  }
  // núcleo: defectos y arranque de procesos base
  OS.kernel.boot();
  startKernelLoop();
  await new Promise((r) => setTimeout(r, 350));
  $('#boot-screen').style.transition = 'opacity 0.6s';
  $('#boot-screen').style.opacity = '0';
  setTimeout(() => $('#boot-screen').remove(), 650);
  $('#desktop').classList.remove('hidden');
  OS.toast('🧠 SimSys OS iniciado — ' + OS.kernel.processes.length + ' procesos cargados');
  WM.open(AppProcess.name);
}

/* ========================= init ========================= */
window.addEventListener('DOMContentLoaded', () => {
  OSApp.kernel = OS.kernel; // las apps usan OSApp.kernel
  Apps.forEach((a) => (a.id = a.name));
  buildMenus();
  initTaskbarActions();
  initClock();
  watchKernelEvents();
  boot();
});
