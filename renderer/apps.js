// ============================================================
// SimSys OS — aplicaciones del escritorio simulado
// Cada app define: { name, icon, w, h, launch(body, win) }
// `win` ofrece: win.onTick(fn) para redibujar en cada tick
//               win.notify(msg) para notificar
// ============================================================
'use strict';

/* ============================== utilidades ============================== */
const $ = (sel, r = document) => r.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};

const STATE_ES = {
  new: 'Nuevo',
  ready: 'Listo',
  running: 'Ejecución',
  blocked: 'Bloqueado',
  suspended: 'Suspendido',
  terminated: 'Terminado',
};
const getStateEs = (s) => STATE_ES[s] || s;

/* ============== registro global disponible para las apps ================ */
const OSApp = {
  kernel: null,
  windows: new Map(), // appId -> win
  tickSubs: new Set(),
};

/* ============================================================
   1) MONITOR DE PROCESOS
   ============================================================ */
const AppProcess = {
  name: 'Monitor de Procesos',
  icon: '📊',
  w: 1080, h: 680,
  sel: new Set(),
  metricMode: 'cpu',
  launch(body, win) {
    const k = OSApp.kernel;

    body.appendChild(el('div', 'row-actions', `
      <button data-act="create" class="primary">➕ Crear proceso</button>
      <button data-act="ndl">🚨 Ver grafo de espera</button>
      <button data-act="clearsel">Quitar selección</button>
      <span style="flex:1"></span>
      <span class="tag">quantum por proceso · prioridades · desalojo</span>
    `));

    const grid = el('div', 'grid-2');
    const left = el('div');
    const right = el('div');
    grid.append(left, right);
    body.appendChild(grid);

    // --------- tabla de procesos ---------
    const tblWrap = el('div', 'panel');
    tblWrap.appendChild(el('h3', null, 'Procesos del sistema <small>(estado · prioridad · quantum · recursos)</small>'));
    const scroll = el('div', null);
    scroll.style.maxHeight = '330px';
    scroll.style.overflowY = 'auto';
    tblWrap.appendChild(scroll);
    left.appendChild(tblWrap);

    // --------- gráficas por selección del usuario ---------
    const chartsPanel = el('div', 'panel');
    chartsPanel.appendChild(el('h3', null, 'Gráficas <small>por selección de usuario</small>'));
    const pick = el('div', 'checkline');
    pick.innerHTML = `
      <label><input type="checkbox" data-m="cpu" checked> Uso de CPU</label>
      <label><input type="checkbox" data-m="mem" checked> Uso de memoria</label>
      <label><input type="checkbox" data-m="io" checked> Ocupación de E/S</label>
      <label><input type="checkbox" data-m="gantt" checked> Franja Gantt por proceso</label>`;
    chartsPanel.appendChild(pick);
    const line1 = el('canvas', null);
    const gantt = el('canvas', null);
    // El TAMAÑO VISIBLE del canvas lo fija el CSS una sola vez: los
    // redibujados solo cambian la resolución del bitmap, nunca la
    // disposición (layout) de la ventana.
    line1.style.cssText = 'width:100%;height:170px;display:block';
    gantt.style.cssText = 'width:100%;display:block';
    chartsPanel.append(line1, gantt);
    const redrawAll = () => {
      AppProcess.redrawCharts(line1, gantt, k, chartsPanel);
      AppProcess.redrawProcsChart(procLine, k);
    };
    chartsPanel.querySelectorAll('input[data-m]').forEach((cb) => (cb.addEventListener('change', redrawAll)));
    left.appendChild(chartsPanel);

    const chartsPick2 = el('div', 'panel');
    chartsPick2.appendChild(el('h3', null, 'Actividad por proceso <small>elige los PIDs a graficar</small>'));
    const procsPick = el('div', 'checkline');
    chartsPick2.appendChild(procsPick);
    const procLine = el('canvas');
    procLine.style.cssText = 'width:100%;height:190px;display:block';
    chartsPick2.appendChild(procLine);
    right.appendChild(chartsPick2);

    // métricas generales
    const stats = el('div', 'panel');
    right.appendChild(stats);

    // acciones
    body.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'create') window.createProcessDialog();
      if (act === 'ndl') showWaitGraph();
      if (act === 'clearsel') { OSApp._selProcs = new Set(); }
    });

    win.onTick(() => {
      AppProcess._renderTable(scroll, k);
      AppProcess._renderProcsPicker(procsPick, k);
      AppProcess._renderStats(stats, k);
      AppProcess.redrawCharts(line1, gantt, k, chartsPanel);
      AppProcess.redrawProcsChart(procLine, k);
    });
  },

  _renderTable(scroll, k) {
    const st = scroll.scrollTop; // conservar la posición de scroll entre ticks
    const rows = k.processes.slice().sort((a, b) => (a.state === 'terminated') - (b.state === 'terminated') || b.priority - a.priority || a.pid - b.pid);
    const html = `<table class="data"><thead><tr>
      <th>PID</th><th></th><th>Proceso</th><th>Estado</th><th>Prio</th><th>Quantum</th><th>Q. rest.</th><th>Mem</th><th>Progreso</th><th>Recursos E/S</th><th>Espera</th><th></th>
    </tr></thead><tbody>` +
      rows.map((p) => {
        const prog = Math.round(100 - (p.burstLeft / p.burstTotal) * 100);
        const devs = [];
        for (const h of p.devicesHeld) {
          const d = k._device(h.devId);
          devs.push(`${d?.icon || '💾'}${h.devId}${h.mode === 'hold' ? '(en uso)' : ''}`);
        }
        if (p.deviceWanted) devs.push(`⏳${p.deviceWanted}`);
        if (p.blockedOn && p.blockedOn.startsWith('sem:')) devs.push('🔒' + p.blockedOn.slice(4));
        const isDead = k.deadlock.active && k.deadlock.cycle.includes(p.pid);
        return `<tr data-pid="${p.pid}" class="${p.state === 'terminated' ? 'terminated' : ''} ${p.starved ? 'starved' : ''}">
          <td><b>${p.pid}</b></td><td>${p.icon}</td><td>${p.name}</td>
          <td><span class="pill ${p.state}">${getStateEs(p.state)}</span>${isDead ? ' <span class="pill deadlock">DEADLOCK</span>' : ''}</td>
          <td>${p.priority}</td><td>${p.quantum}</td><td>${p.state === 'running' ? p.quantumLeft : '—'}</td>
          <td>${p.memBlocks ? p.memBlocks.length * k.cfg.blockSize + 'MB' : (p.state === 'suspended' ? 'swap' : '—')}</td>
          <td><div class="mini-bar"><div style="width:${prog}%"></div></div></td>
          <td><small>${devs.join(' ') || '—'}</small></td>
          <td style="color:${p.waitedTicks > k.cfg.starvationThreshold ? 'var(--warn)' : 'inherit'}">${p.state === 'ready' ? p.waitedTicks : '—'}</td>
          <td>${p.state !== 'terminated' ? `<button class="small" data-kill="${p.pid}" title="Terminar">✕</button>
              <button class="small" data-wait="${p.pid}" title="Bajar prioridad">▼</button>
              <button class="small" data-nice="${p.pid}" title="Subir prioridad">▲</button>` : ''}
              ${p.state === 'ready' || p.state === 'running' ? `<button class="small" data-susp="${p.pid}" title="Suspender">⏸</button>` : ''}
              ${p.state === 'suspended' ? `<button class="small" data-res="${p.pid}" title="Reanudar">⏵</button>` : ''}</td>
        </tr>`;
      }).join('') + '</tbody></table>';
    scroll.innerHTML = html;
    scroll.scrollTop = st;

    scroll.onclick = (e) => {
      const t = e.target;
      const pidOf = (d) => k.processes.find((p) => p.pid == d);
      if (t.dataset.kill) OS.kernel.kill(+t.dataset.kill, 'finalizado por el usuario desde el monitor');
      if (t.dataset.nice) OS.kernel.setPriority(+t.dataset.nice, pidOf(t.dataset.nice).priority + 1);
      if (t.dataset.wait) OS.kernel.setPriority(+t.dataset.wait, pidOf(t.dataset.wait).priority - 1);
      if (t.dataset.susp) OS.kernel.suspend(+t.dataset.susp);
      if (t.dataset.res) OS.kernel.resume(+t.dataset.res);
    };
  },

  _renderProcsPicker(pick, k) {
    const live = k.processes.filter((p) => p.state !== 'terminated' && p.state !== 'new').slice(-14);
    if (!live.length) { pick.innerHTML = '<i>sin procesos activos</i>'; return; }
    const sel = OSApp._selProcs || new Set();
    pick.innerHTML = live
      .map((p) => `<label><input type="checkbox" data-pid="${p.pid}" ${sel.has(p.pid) ? 'checked' : ''}><span>${p.icon} ${p.pid}</span></label>`)
      .join('');
    pick.querySelectorAll('input[data-pid]').forEach((cb) =>
      (cb.onchange = () => {
        const id = +cb.dataset.pid;
        sel.has(id) ? sel.delete(id) : sel.add(id);
        OSApp._selProcs = sel;
      })
    );
  },

  _renderStats(stats, k) {
    const sc = k.stateCounts();
    const ms = k.memStats();
    stats.innerHTML = `<h3>Métricas del núcleo</h3><div class="stat-lines">
      <div><span class="k">Tick actual</span><span class="v">${k.ticks}</span></div>
      <div><span class="k">Alternancias de contexto</span><span class="v">${k.metrics.contextSwitches}</span></div>
      <div><span class="k">Interbloqueos detectados / resueltos</span><span class="v">${k.metrics.deadlocksDetected} / ${k.metrics.deadlocksResolved}</span></div>
      <div><span class="k">Casos de inanición (mitigados con aging)</span><span class="v">${k.metrics.starved}</span></div>
      <div><span class="k">Compactaciones de memoria</span><span class="v">${k.metrics.compactations}</span></div>
      <div><span class="k">Fragmentación interna / externa</span><span class="v">${ms.internalFragMB} MB / ${ms.fragExternaPct.toFixed(1)}%</span></div>
      <div><span class="k">Huecos en memoria</span><span class="v">${ms.holes}</span></div>
      <div><span class="k">Operaciones semwait / semsignal</span><span class="v">${k.metrics.semWaitOps} / ${k.metrics.semSignalOps}</span></div>
      <div><span class="k">Estados</span><span class="v">N${sc.new} · L${sc.ready} · E${sc.running} · B${sc.blocked} · S${sc.suspended} · T${sc.terminated}</span></div>
    </div>`;
  },

  redrawCharts(line1, ganttC, k, panel) {
    const show = (m) => panel.querySelector(`input[data-m="${m}"]`).checked;
    const series = [];
    if (show('cpu')) series.push({ name: 'CPU %', color: '#43d17a', data: k.history.cpu });
    if (show('mem')) series.push({ name: 'Memoria %', color: '#b06cf5', data: k.history.mem });
    if (show('io')) series.push({ name: 'E/S ocupada %', color: '#ffb84f', data: k.history.io });
    // el ancho visible lo fija el CSS (width:100%); Chart.lineChart lee
    // clientWidth y no dibuja si la ventana está minimizada (clientWidth=0)
    Chart.lineChart(line1, series, { height: 170 });
    const showG = show('gantt');
    ganttC.style.display = showG ? 'block' : 'none';
    if (showG) {
      const rows = k.processes.filter((p) => p.state !== 'terminated').slice(-14);
      Chart.ganttStrip(ganttC, k.history.ganttPts, rows.map((p) => ({ pid: p.pid })), 120);
    }
  },

  redrawProcsChart(canvas, k) {
    const sel = OSApp._selProcs || new Set();
    const series = [];
    let idx = 0;
    for (const p of k.processes) {
      if (sel.has(p.pid) && p.state !== 'terminated') {
        series.push({ name: `${p.pid} ${p.icon}`, color: Chart.colorFor(idx++), data: p.hist.map((h) => ({ t: h.t, v: h.s })) });
      }
    }
    if (!series.length) {
      // sin selección: muestra la actividad de los primeros procesos activos
      for (const p of k.processes.filter((x) => x.state === 'running').slice(0, 4)) {
        series.push({ name: `${p.pid} ${p.icon}`, color: Chart.colorFor(idx++), data: p.hist.map((h) => ({ t: h.t, v: h.s })) });
      }
    }
    // el ancho visible lo fija el CSS; lineChart no dibuja si está oculto
    Chart.lineChart(canvas, series, { height: 190 });
  },
};

/* ============================================================
   2) GESTIÓN DE MEMORIA
   ============================================================ */
const AppMemory = {
  name: 'Gestión de Memoria',
  icon: '🧠',
  w: 940, h: 620,
  launch(body, win) {
    const k = OSApp.kernel;
    const top= el('div', 'grid-2');
    const left = el('div', 'panel');
    left.innerHTML = `<h3>Mapa de memoria <small>bloques de ${k.cfg.blockSize} MB</small></h3>`;
    const map = el('div', 'mem-map');
    map.style.maxHeight = '210px';
    left.appendChild(map);
    const legend = el('div', 'mem-legend');
    left.appendChild(legend);
    top.appendChild(left);

    const right = el('div', 'panel');
    right.innerHTML = '<h3>Estado y fragmentación</h3>';
    const stats = el('div', 'stat-lines');
    right.appendChild(stats);
    const fragPanel = el('div', 'panel');
    fragPanel.style.marginTop = '10px';
    fragPanel.innerHTML = '<h3>Fragmentación interna por proceso</h3>';
    const fragList = el('div');
    fragPanel.appendChild(fragList);
    right.appendChild(fragPanel);
    top.appendChild(right);
    body.appendChild(top);

    const actions = el('div', 'row-actions');
    actions.innerHTML = `
      <button class="primary" data-act="compact">🧹 Compactar memoria</button>
      <label style="display:flex;gap:6px;align-items:center">Estrategia:
        <select id="mem-strat"><option value="first">Primer ajuste (first-fit)</option><option value="best">Mejor ajuste (best-fit)</option></select>
      </label>`;
    body.appendChild(actions);
    actions.querySelector('#mem-strat').value = k.strategy;
    actions.querySelector('[data-act="compact"]').onclick = () => k.compact();
    actions.querySelector('#mem-strat').onchange = (e) => k.setStrategy(e.target.value);

    const donut = el('canvas');
    donut.style.cssText = 'width:160px;height:160px;display:block;max-width:100%';
    const donutPanel = el('div', 'panel');
    donutPanel.innerHTML = '<h3>Proporción de memoria</h3>';
    donutPanel.appendChild(donut);
    body.appendChild(donutPanel);

    win.onTick(() => {
      const st = k.memStats();
      // mapa
      const cells = k.memBlocks.map((b, i) => {
        const bg = b === null ? 'background:rgba(255,255,255,0.06)' : `background:${Chart.colorFor(b % 15)}`;
        return `<div class="mem-cell" style="${bg}" title="bloque ${i} — ${b === null ? 'hueco libre' : 'PID ' + b}">${b === null ? '' : b}</div>`;
      }).join('');
      map.innerHTML = cells;
      const used = new Set(k.memBlocks.filter((b) => b !== null));
      legend.innerHTML =
        `<span><span class="legend-dot" style="background:rgba(255,255,255,0.15)"></span>libre / hueco</span>` +
        [...used].slice(0, 12).map((pid) => {
          const p = k.processes.find((x) => x.pid === pid);
          return `<span><span class="legend-dot" style="background:${Chart.colorFor(pid % 15)}"></span>PID ${pid} ${p ? p.icon : ''}</span>`;
        }).join('');
      // stats
      stats.innerHTML = `
        <div><span class="k">Memoria total</span><span class="v">${st.totalMB} MB</span></div>
        <div><span class="k">Usada (procesos residentes)</span><span class="v">${st.usedMB} MB (${st.usedPct.toFixed(1)}%)</span></div>
        <div><span class="k">Libre</span><span class="v">${st.freeMB} MB</span></div>
        <div><span class="k">Huecos libres (fragmentación externa)</span><span class="v">${st.holes} huecos · ${st.holeBytes} MB</span></div>
        <div><span class="k">% fragmentación externa</span><span class="v" style="color:${st.fragExternaPct > 30 ? 'var(--warn)' : 'inherit'}">${st.fragExternaPct.toFixed(1)}%</span></div>
        <div><span class="k">Fragmentación interna total</span><span class="v">${st.internalFragMB} MB</span></div>
        <div><span class="k">Compactaciones automáticas</span><span class="v">${k.metrics.compactations}</span></div>`;
      // frag interna por proceso
      const rows = k.processes.filter((p) => p.memBlocks && p.internalFrag > 0);
      fragList.innerHTML = rows.length
        ? rows.map((p) => `<div class="frag-row"><span>${p.icon} PID ${p.pid}</span><div class="mini-bar"><div style="width:${Math.min(100, (p.internalFrag / (p.memBlocks.length * k.cfg.blockSize)) * 100)}%;background:var(--warn)"></div></div><span>+${p.internalFrag} MB</span></div>`).join('')
        : '<i style="color:var(--muted);font-size:11px">sin fragmentación interna ahora mismo</i>';
      Chart.donutChart(donut, [
        { value: st.usedMB, color: '#b06cf5' },
        { value: st.holeBytes, color: '#ffb84f' },
        { value: Math.max(0, st.freeMB - st.holeBytes), color: 'rgba(255,255,255,0.14)' },
      ], { size: 150 });
    });
  },
};

/* ============================================================
   3) RECURSOS Y HARDWARE
   ============================================================ */
const AppResources = {
  name: 'Recursos y Hardware',
  icon: '🖥️',
  w: 1000, h: 660,
  launch(body, win) {
    const k = OSApp.kernel;
    body.appendChild(el('div', 'row-actions', `<span class="tag">gestión de dispositivos de E/S · disco duro · CPU física real</span>`));
    const top = el('div', 'grid-2');
    const devPanel = el('div', 'panel');
    devPanel.innerHTML = '<h3>Dispositivos de E/S <small>(instancia ↔ proceso asignado)</small></h3>';
    const devGrid = el('div', null);
    devGrid.style.cssText = 'display:grid;grid-template-columns:1fr;gap:8px';
    devPanel.appendChild(devGrid);
    top.appendChild(devPanel);

    const cpuPanel = el('div', 'panel');
    cpuPanel.innerHTML = '<h3>Procesadores simulados</h3>';
    const coresGrid = el('div', 'core-bars');
    cpuPanel.appendChild(coresGrid);
    const cpuNote = el('div', 'stat-lines');
    cpuPanel.appendChild(cpuNote);
    top.appendChild(cpuPanel);
    body.appendChild(top);

    const grid2 = el('div', 'grid-2');
    const diskPanel = el('div', 'panel');
    diskPanel.innerHTML = '<h3>Disco duro (simulado) <small>escrituras de procesos</small></h3>';
    const diskBar = el('div');
    diskPanel.appendChild(diskBar);
    const diskFiles = el('div', 'logbox');
    diskPanel.appendChild(diskFiles);
    grid2.appendChild(diskPanel);

    const hwPanel = el('div', 'panel');
    hwPanel.innerHTML = '<h3>Hardware real del equipo anfitrión</h3>';
    const hwBody = el('div', 'stat-lines');
    hwPanel.appendChild(hwBody);
    const realCores = el('div', 'core-bars');
    hwPanel.appendChild(realCores);
    grid2.appendChild(hwPanel);
    body.appendChild(grid2);

    let hw = null;
    const loadHw = async () => {
      try { hw = await window.osAPI.getHardware(); } catch (_) { hw = null; }
    };
    loadHw();

    win.onTick(() => {
      // dispositivos
      devGrid.innerHTML = k.devices.map((d) => `
        <div class="dev-card">
          <div class="d-icon">${d.icon}</div>
          <div><div class="d-name">${d.name}</div><div class="d-info">espera: ${d.queue.length} proceso(s)</div></div>
          <div class="dev-slots">${d.allocated
            .map((pid) => `<div class="dev-slot ${pid !== null ? 'busy' : ''}" ${pid !== null ? `title="PID ${pid}"` : ''}>${pid === null ? '—' : 'PID ' + pid}</div>`)
            .join('')}</div>
        </div>`).join('');

      // cores
      coresGrid.innerHTML = k.cores.map((c) => {
        const p = c.pid !== null ? k.processes.find((x) => x.pid === c.pid) : null;
        const active = p && p.state === 'running';
        return `<div class="core-bar" style="height:${active ? 60 + Math.random() * 30 : 4}px;background:${active ? 'linear-gradient(180deg,var(--accent2),rgba(67,209,122,0.25))' : undefined}"
          title="${p ? p.name : 'libre'}"><span>core${c.idx}${active ? ' ' + p.pid : ''}</span></div>`;
      }).join('');
      cpuNote.innerHTML = `<div><span class="k">Carga de la CPU simulada</span><span class="v">${k.cpuLoad().toFixed(0)}%</span></div>
        <div><span class="k">Alternancias de contexto</span><span class="v">${k.metrics.contextSwitches}</span></div>`;

      // disco simulado
      const usedP = ((k.disk.usedMB / k.disk.totalMB) * 100).toFixed(1);
      diskBar.innerHTML = `<div class="mini-bar" style="height:10px;margin-bottom:6px"><div style="width:${usedP}%;background:var(--accent)"></div></div>
        <div style="font-size:11.5px;color:var(--muted);margin-bottom:6px">${(k.disk.usedMB / 1024).toFixed(2)} GB de ${(k.disk.totalMB / 1024).toFixed(0)} GB en uso (${usedP}%)</div>`;
      diskFiles.innerHTML = k.disk.files.slice().reverse().slice(0, 30).map((f) =>
        `📄 <b>${f.name}</b> <span style="color:var(--muted)">PID ${f.owner} · ${f.sizeMB} MB</span>`).join('');

      // hardware real
      if (hw) {
        hwBody.innerHTML = `
          <div><span class="k">Sistema</span><span class="v">${hw.platform}</span></div>
          <div><span class="k">CPU física</span><span class="v">${hw.cpu.cores} núcleos</span></div>
          <div><span class="k">Modelo</span><span class="v" style="max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${hw.cpu.model}</span></div>
          <div><span class="k">RAM total / libre</span><span class="v">${hw.mem.total.toFixed(1)} / ${hw.mem.free.toFixed(1)} GB</span></div>
          <div><span class="k">Disco real ${hw.disk.mount}</span><span class="v">${hw.disk.used.toFixed(0)} de ${hw.disk.total.toFixed(0)} GB</span></div>`;
        realCores.innerHTML = hw.cpu.usage.map((u, i) =>
          `<div class="core-bar" style="height:${Math.max(4, u * 0.62)}px;background:linear-gradient(180deg,var(--accent),rgba(79,140,255,0.25))"><span>h${i}</span></div>`).join('');
      }
    });
  },
};

/* ============================================================
   4) EXPLORADOR DE ARCHIVOS (sistema de archivos virtual)
   ============================================================ */
const AppFiles = {
  name: 'Explorador de Archivos',
  icon: '📁',
  w: 860, h: 600,
  launch(body, win) {
    const k = OSApp.kernel;
    if (!k) { body.innerHTML = '<div style="padding:20px;color:var(--muted)">El núcleo aún no está listo, espera unos segundos…</div>'; return; }
    body.appendChild(el('h2', 'app-title', '📁 Sistema de archivos <span class="tag">navegable — coincide con la terminal (ls, cd, cat…)</span>'));
    const grid = el('div', 'grid-2');
    grid.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;align-items:start';
    // árbol de directorios
    const treePanel = el('div', 'panel');
    treePanel.innerHTML = '<h3>Árbol de directorios</h3>';
    const treeBox = el('div');
    treeBox.style.cssText = 'max-height:480px;overflow-y:auto;font-size:12.5px;line-height:1.9';
    treePanel.appendChild(treeBox);
    grid.appendChild(treePanel);
    // archivos generados por procesos (disco)
    const diskPanel = el('div', 'panel');
    diskPanel.innerHTML = '<h3>Archivos generados por los procesos <small>disco duro</small></h3>';
    const diskBox = el('div', null);
    diskBox.style.cssText = 'max-height:480px;overflow-y:auto;font-size:11.5px';
    diskPanel.appendChild(diskBox);
    grid.appendChild(diskPanel);
    body.appendChild(grid);

    let expanded = new Set(['home', 'home/juan', 'etc', 'proc']);

    const drawNode = (node, parts, depth) => {
      const pathKey = parts.join('/');
      if (node.type === 'file') {
        const size = (k.fsFileContent(node) || '').length;
        const row = el('div', null, `<span class="legend-dot" style="background:var(--accent2)"></span> 📄 ${node.name} <small style="color:var(--muted)">${size} B${node.virtual ? ' · virtual (estado en vivo del núcleo)' : ''}</small>`);
        row.style.cssText = 'cursor:pointer;padding-left:' + (depth * 16 + 4) + 'px';
        row.ondblclick = () => {
          const layer = $('#modal-layer');
          layer.classList.remove('hidden');
          layer.innerHTML = `<div class="dialog"><div class="d-head">📄 ${pathStr('/' + pathKey)}</div>
            <div class="d-body"><pre style="white-space:pre-wrap;font-size:12px;line-height:1.6">${escapeHtml(k.fsFileContent(node) || '(vacío)')}</pre></div>
            <div class="d-foot"><button id="f-close">Cerrar</button></div></div>`;
          layer.querySelector('#f-close').onclick = () => { layer.classList.add('hidden'); layer.innerHTML = ''; };
        };
        return [row];
      }
      // directorio
      const isOpen = expanded.has(pathKey);
      const head = el('div', null, `<span style="cursor:pointer">🗂️ <b>${node.name || '/'}</b></span>`);
      head.style.cssText = 'padding-left:' + (depth * 16) + 'px';
      head.onclick = () => { isOpen ? expanded.delete(pathKey) : expanded.add(pathKey); renderTree(); };
      const out = [head];
      if (isOpen) for (const c of node.children) out.push(...drawNode(c, [...parts, c.name], depth + 1));
      return out;
    };

    const pathStr = (p) => p;
    function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    function renderTree() {
      treeBox.innerHTML = '';
      const root = el('div', null, '🗂️ <b>/ (raíz)</b>');
      root.style.cursor = 'pointer';
      root.onclick = () => {
        const topNames = k.fs.children.map((c) => c.name);
        const allOpen = topNames.every((n) => expanded.has(n));
        if (allOpen) expanded = new Set(['home', 'home/juan']);
        else for (const n of topNames) expanded.add(n);
        renderTree();
      };
      treeBox.appendChild(root);
      for (const c of k.fs.children) treeBox.append(...drawNode(c, [c.name], 1));
    }
    renderTree();
    // refresco suave del árbol (contenido cambia: /proc, /var/log…)
    let lastFsSize = -1;
    win.onTick(() => {
      const count = (n) => (n.type === 'dir' ? n.children.reduce((a, c) => a + count(c), 0) : 1);
      const size = count(k.fs);
      if (size !== lastFsSize) { lastFsSize = size; renderTree(); }
      const files = k.disk.files.slice().reverse().slice(0, 24);
      diskBox.innerHTML = '<table class="data"><tbody>' + files.map((f) => {
        const p = k.processes.find((x) => x.pid === f.owner);
        return `<tr><td>${f.owner === 0 ? '⚙️' : '📄'}</td><td>${f.name}</td><td>${p ? p.icon + ' ' + p.name : f.ownerName}</td><td>${f.sizeMB} MB</td></tr>`;
      }).join('') + '</tbody></table>';
    });
  },
};

/* ============================================================
   5) TERMINAL — con sistema de archivos y navegación web
   ============================================================ */
const AppTerminal = {
  name: 'Terminal',
  icon: '⌨️',
  w: 780, h: 520,
  launch(body, win) {
    body.style.padding = '0';
    const term = el('div', 'term');
    const out = el('div', null);
    out.id = 'term-out';
    const row = el('div', 'term-input-row', `<span id="term-prompt">simsys&gt;</span><input id="term-in" autocomplete="off" spellcheck="false" />`);
    term.append(out, row);
    body.appendChild(term);
    const input = row.querySelector('#term-in');
    const promptEl = row.querySelector('#term-prompt');
    const k = OSApp.kernel;

    if (!OSApp._cwd) OSApp._cwd = ['home', 'juan'];
    const print = (txt, cls = '') => {
      const l = el('div', cls);
      l.textContent = txt;
      out.appendChild(l);
      out.scrollTop = out.scrollHeight;
    };
    const printHtml = (txt, cls = '') => {
      const l = el('div', cls);
      l.innerHTML = txt;
      out.appendChild(l);
      out.scrollTop = out.scrollHeight;
    };
    const pathStr = (parts) => '/' + parts.join('/');
    const pwd = () => pathStr(OSApp._cwd);

    // motd al abrir
    const motd = k.fsLookup(['etc', 'motd']);
    if (motd) print(k.fsFileContent(motd), 't-info');
    print('\nEscribe "help" para ver todos los comandos. "fs-help" para navegar archivos.\n', 't-info');
    const setPrompt = () => { promptEl.textContent = `${OS.kernel.user || 'juan'}@simsys:${pwd()}$`; };
    setPrompt();

    // divide tokens respetando comillas: echo "hola mundo" > a.txt
    const tokenize = (s) => {
      const out = [];
      const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
      let m;
      while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
      return out;
    };

    const run = (cmdline) => {
      const tokens = tokenize(cmdline);
      const [cmd, ...args] = tokens;
      const arg = args.join(' ');
      switch (cmd.toLowerCase()) {
        /* ------------------------- ayuda ------------------------- */
        case 'help':
          print(`núcleo y procesos:
  ps · top                lista / prioridades de los procesos
  kill <pid>              termina un proceso
  nice <pid> <0-10>       cambia la prioridad
  quantum <pid> <1-12>    cambia su quantum
  create [nombre]         crea un proceso nuevo
  suspend <pid> · resume <pid>
  deadlock                estado del interbloqueo
  pause · resume-sys      pausa o reanuda el núcleo
  uptime · clear · exit

memoria y recursos:
  mem · compact · strat <first|best>
  dev · disk · df

sistema de archivos (ver "fs-help"):
  ls · cd · pwd · cat · echo · mkdir · touch · rm · mv · tree · find

web y mensajería (navegador interno):
  open telegram|whatsapp|<url>   abre el navegador integrado
  browse <búsqueda|url>          busca en la web interna`);
          break;
        case 'fs-help':
          print(`navegación de archivos:
  pwd                     carpeta actual
  ls [-l]                 contenido de la carpeta
  cd <ruta>               cambia de carpeta (cd .. · cd / · cd ~ · cd docs)
  cat <archivo>           muestra el contenido
  echo "texto" > archivo.txt      escribe (sobrescribe)
  echo "texto" >> archivo.txt     agrega al final
  touch <archivo>         crea archivo vacío
  mkdir <carpeta>         crea carpeta
  rm [-r] <ruta>          borra archivo/carpeta
  mv <de> <a>             mueve o renombra
  tree                    árbol completo
  find <texto>            busca nombres que coincidan
  df                      uso del disco`);
          break;

        /* ------------------------- procesos ------------------------- */
        case 'ps':
          k.processes.forEach((p) =>
            print(`${String(p.pid).padStart(3)} ${p.icon} ${p.name.padEnd(28)} ${getStateEs(p.state).padEnd(9)} prio ${p.priority} q ${p.quantum} mem ${p.memBlocks ? p.memBlocks.length * k.cfg.blockSize + 'MB' : '—'}`)
          );
          break;
        case 'top':
          k.processes.filter((p) => p.state !== 'terminated').sort((a, b) => b.priority - a.priority)
            .forEach((p) => print(`prio ${p.priority} → PID ${p.pid} ${p.name} (${getStateEs(p.state)}, espera ${p.waitedTicks})`));
          break;
        case 'kill': OS.kernel.kill(+args[0]) ? print('✔ proceso ' + args[0] + ' terminado') : print('pid no válido', 't-err'); break;
        case 'nice': if (args[1] !== undefined) { OS.kernel.setPriority(+args[0], +args[1]); print(`✔ prioridad de ${args[0]} → ${args[1]}`); } else print('uso: nice <pid> <0-10>', 't-err'); break;
        case 'quantum': if (args[1] !== undefined) { OS.kernel.setQuantum(+args[0], +args[1]); print(`✔ quantum de ${args[0]} → ${args[1]} ticks`); } else print('uso: quantum <pid> <1-12>', 't-err'); break;
        case 'create': window.createProcessDialog(); print('✔ diálogo de creación abierto'); break;
        case 'suspend': OS.kernel.suspend(+args[0]); print('✔ suspendido (paso a swap)'); break;
        case 'resume': OS.kernel.resume(+args[0]); print('✔ reanudado'); break;
        case 'deadlock': print(k.deadlock.active ? `⚠ INTERBLOQUEO activo entre PIDs ${k.deadlock.cycle.join(', ')}` : 'sin interbloqueo detectado'); break;
        case 'pause': OS.pause(true); print('⏸ núcleo pausado'); break;
        case 'resume-sys': OS.pause(false); print('▶ núcleo reanudado'); break;
        case 'uptime': print(`agenda del SO: ${k.ticks} ticks · ${((k.ticks * k.cfg.tickMs) / 1000).toFixed(0)} s de simulación`); break;

        /* ------------------------- memoria ------------------------- */
        case 'mem': {
          const st = k.memStats();
          print(`total ${st.totalMB} MB · usado ${st.usedMB} MB (${st.usedPct.toFixed(1)}%) · libre ${st.freeMB} MB`);
          print(`huecos ${st.holes} (${st.holeBytes} MB) · frag. externa ${st.fragExternaPct.toFixed(1)}% · frag. interna ${st.internalFragMB} MB`);
          break;
        }
        case 'compact': k.compact(); print('✔ memoria compactada'); break;
        case 'strat': k.setStrategy(args[0]); print('✔ estrategia: ' + args[0]); break;
        case 'dev': k.devices.forEach((d) => print(`${d.icon} ${d.name}: ${d.allocated.map((x) => (x === null ? '—' : 'PID ' + x)).join(', ')} · cola ${d.queue.length}`)); break;
        case 'disk': print(`disco: ${(k.disk.usedMB / 1024).toFixed(2)} / ${(k.disk.totalMB / 1024).toFixed(0)} GB · ${k.disk.files.length} archivos generados por procesos`); break;
        case 'df': {
          const countFiles = (n) => n.type === 'dir' ? n.children.reduce((a, c) => a + countFiles(c), 0) : 1;
          const bytesUsed = (n) => n.type === 'dir' ? n.children.reduce((a, c) => a + bytesUsed(c), countFiles(n) * 24) : (k.fsFileContent(n) || '').length;
          print(`sistema de archivos: ${countFiles(k.fs)} entradas · ~${(bytesUsed(k.fs) / 1024).toFixed(1)} KB lógicos`);
          print(`disco duro: ${(k.disk.usedMB / 1024).toFixed(2)} GB de ${(k.disk.totalMB / 1024).toFixed(0)} GB ocupados`);
          break;
        }

        /* ------------------- sistema de archivos ------------------- */
        case 'pwd': print(pwd()); break;
        case 'ls': {
          const targetParts = args.filter((a) => !a.startsWith('-'));
          const parts = targetParts.length ? k.fsResolvePath(OSApp._cwd, targetParts[0]) : OSApp._cwd;
          const node = k.fsLookup(parts);
          if (!node || node.type !== 'dir') { print(`no existe la carpeta '${targetParts.join(' ')}'`, 't-err'); break; }
          const long = args.some((a) => a.startsWith('-') && a.includes('l'));
          const dirs = node.children.filter((c) => c.type === 'dir');
          const files = node.children.filter((c) => c.type === 'file');
          if (!node.children.length) print('(vacío)', 't-info');
          dirs.forEach((d) => print(long ? `drwx  ${pathStr([...parts, d.name])}` : `${d.name}/`));
          files.forEach((f) => {
            const content = k.fsFileContent(f) || '';
            print(long ? `-rw  ${String(content.length).padStart(7)}B  ${f.name}` : f.name + (f.virtual ? '  (virtual del sistema)' : ''));
          });
          break;
        }
        case 'cd': {
          const parts = k.fsResolvePath(OSApp._cwd, args[0] || '~');
          const node = k.fsLookup(parts);
          if (!node || node.type !== 'dir') print(`no existe la carpeta: ${args[0] || ''}`, 't-err');
          else { OSApp._cwd = parts; setPrompt(); }
          break;
        }
        case 'cat': {
          if (!args[0]) { print('uso: cat <archivo>', 't-err'); break; }
          const node = k.fsLookup(k.fsResolvePath(OSApp._cwd, args[0]));
          if (!node) print(`no existe: ${args[0]}`, 't-err');
          else if (node.type === 'dir') print(`${args[0]} es una carpeta`, 't-err');
          else (k.fsFileContent(node) || '').split('\n').forEach((line) => print(line));
          break;
        }
        case 'echo': {
          // orientado a redirección: echo "texto" > archivo [>> append]
          const raw = cmdline.replace(/^echo\s+/i, '');
          const m = raw.match(/^(.*?)\s?(>>|>?)\s*(.+)$/);
          let text = tokens.slice(1);
          let mode = null, file = null;
          if (tokens.includes('>') || tokens.includes('>>')) {
            const gi = tokens.indexOf(tokens.find((t2) => t2 === '>' || t2 === '>>'));
            mode = tokens[gi] === '>>' ? 'append' : 'write';
            file = tokens[gi + 1];
            text = tokens.slice(1, gi);
          }
          const line = text.join(' ');
          if (!file) { print(line); break; }
          const parts = k.fsResolvePath(OSApp._cwd, file);
          const existing = k.fsLookup(parts);
          let newContent = line;
          if (mode === 'append' && existing) newContent = (k.fsFileContent(existing) || '') + '\n' + line;
          const err = k.fsWriteFile(parts, newContent);
          err ? print(err, 't-err') : print(`✔ ${mode === 'append' ? 'agregado a' : 'escrito en'} ${pathStr(parts)}`);
          break;
        }
        case 'touch': {
          if (!args[0]) { print('uso: touch <archivo>', 't-err'); break; }
          const parts = k.fsResolvePath(OSApp._cwd, args[0]);
          const err = k.fsWriteFile(parts, '');
          err ? print(err, 't-err') : print(`✔ ${args[0]} listo`);
          break;
        }
        case 'mkdir': {
          if (!args[0]) { print('uso: mkdir <carpeta>', 't-err'); break; }
          const err = k.fsMkdir(k.fsResolvePath(OSApp._cwd, args[0]));
          err ? print(err, 't-err') : print(`✔ carpeta ${args[0]} creada`);
          break;
        }
        case 'rm': {
          const recursive = args.some((a) => a.startsWith('-') && a.includes('r'));
          const target = args.find((a) => !a.startsWith('-'));
          if (!target) { print('uso: rm [-r] <ruta>', 't-err'); break; }
          const err = k.fsDelete(k.fsResolvePath(OSApp._cwd, target), recursive);
          err ? print(err, 't-err') : print(`✔ ${target} eliminado`);
          break;
        }
        case 'mv': {
          if (args.length < 2) { print('uso: mv <origen> <destino>', 't-err'); break; }
          const err = k.fsMove(k.fsResolvePath(OSApp._cwd, args[0]), k.fsResolvePath(OSApp._cwd, args[1]));
          err ? print(err, 't-err') : print(`✔ movido ${args[0]} → ${args[1]}`);
          break;
        }
        case 'tree': {
          const walk = (node, prefix = '') => {
            const kids = node.type === 'dir' ? node.children : [];
            kids.forEach((c, i) => {
              const last = i === kids.length - 1;
              print(prefix + (last ? '└─ ' : '├─ ') + c.name + (c.type === 'dir' ? '/' : ''), c.type === 'dir' ? 't-info' : '');
              if (c.type === 'dir') walk(c, prefix + (last ? '   ' : '│  '));
            });
          };
          printHtml('<b>/</b>');
          walk(k.fs);
          break;
        }
        case 'find': {
          if (!args[0]) { print('uso: find <texto>', 't-err'); break; }
          let hits = [];
          const walk = (node, pathParts) => {
            if (node.type === 'dir') node.children.forEach((c) => walk(c, [...pathParts, c.name]));
            else if (node.name.toLowerCase().includes(args[0].toLowerCase())) hits.push(pathStr(pathParts));
          };
          walk(k.fs, []);
          hits.length ? hits.forEach((h) => print(h)) : print('sin coincidencias', 't-info');
          break;
        }

        /* ----------------- web / navegador interno ----------------- */
        case 'open': {
          const a0 = (args[0] || '').toLowerCase();
          if (a0.includes('telegram')) { WM.open('Telegram Web'); print('✔ Telegram Web abierto en el navegador interno'); }
          else if (a0.includes('whatsapp')) { WM.open('WhatsApp Web'); print('✔ WhatsApp Web abierto en el navegador interno'); }
          else if (a0) {
            OSApp._pendingUrl = a0.startsWith('http') ? args[0] : (args[0].includes('.') ? 'https://' + args[0] : null);
            if (!OSApp._pendingUrl) { print('uso: open telegram|whatsapp|<url>', 't-err'); break; }
            WM.open('Navegador Web');
            print('✔ navegador interno abierto: ' + OSApp._pendingUrl);
          } else print('uso: open telegram|whatsapp|<url>', 't-err');
          break;
        }
        case 'browse': {
          if (!args.length) { print('uso: browse <búsqueda o url>', 't-err'); break; }
          const q = args.join(' ');
          OSApp._pendingUrl = /^https?:\/\//.test(q) || (q.includes('.') && !q.includes(' ')) ? (/^https?:/.test(q) ? q : 'https://' + q) : null;
          OSApp._pendingQuery = OSApp._pendingUrl ? null : q;
          WM.open('Navegador Web');
          print(OSApp._pendingUrl ? `✔ abriendo ${OSApp._pendingUrl}` : `✔ buscando “${q}” en la web`);
          break;
        }

        case 'clear': out.innerHTML = ''; break;
        case 'exit': win.close(); break;
        default: print(`comando no reconocido: ${cmd} — prueba "help"`, 't-err');
      }
    };

    input.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      const cmdline = input.value.trim();
      input.value = '';
      if (!cmdline) return;
      print(`${pwd()}$ ${cmdline}`, 't-cmd');
      run(cmdline);
      out.scrollTop = out.scrollHeight;
      setTimeout(() => input.focus(), 30);
    };
    setTimeout(() => input.focus(), 60);
  },
};

/* ============================================================
   6) SINCRONIZACIÓN Y FLUJO DE INFORMACIÓN
   ============================================================ */
const AppSync = {
  name: 'Estados y Flujo del SO',
  icon: '🔄',
  w: 980, h: 660,
  launch(body, win) {
    const k = OSApp.kernel;
    body.appendChild(el('h2', 'app-title', '🔄 Sincronización de procesos · estados y transiciones · flujo de información'));

    const statesPanel = el('div', 'panel');
    statesPanel.appendChild(el('h3', null, 'Estados y transiciones <small>cantidades actuales por estado</small>'));
    const badges = el('div', 'state-badges');
    statesPanel.appendChild(badges);
    const pipes = el('div', 'pipeline');
    pipes.style.marginTop = '12px';
    statesPanel.appendChild(pipes);
    body.appendChild(statesPanel);

    const grid = el('div', 'grid-2');
    // semáforos y buffer
    const syncPanel = el('div', 'panel');
    syncPanel.innerHTML = '<h3>Semáforos y memoria compartida <small>productor/consumidor</small></h3>';
    const sems = el('div', 'stat-lines');
    syncPanel.appendChild(sems);
    const buf = el('div', 'buffer-slots');
    syncPanel.appendChild(buf);
    grid.appendChild(syncPanel);

    // flujo de eventos
    const logPanel = el('div', 'panel');
    logPanel.innerHTML = '<h3>Flujo de información del núcleo <small>(registro de eventos)</small></h3>';
    const logBox = el('div', 'logbox');
    logPanel.appendChild(logBox);
    grid.appendChild(logPanel);
    body.appendChild(grid);

    logPanel.querySelector('h3').style.marginBottom = '6px';
    win.onTick(() => {
      const sc = k.stateCounts();
      badges.innerHTML = `
        <div class="state-badge"><b>${sc.new}</b><span>${getStateEs('new')}</span></div>
        <div class="state-badge b-ready"><b>${sc.ready}</b><span>${getStateEs('ready')}</span></div>
        <div class="state-badge b-running b-running"><b>${sc.running}</b><span>${getStateEs('running')}</span></div>
        <div class="state-badge b-blocked"><b>${sc.blocked}</b><span>${getStateEs('blocked')}</span></div>
        <div class="state-badge b-suspended"><b>${sc.suspended}</b><span>${getStateEs('suspended')}</span></div>
        <div class="state-badge"><b>${sc.terminated}</b><span>${getStateEs('terminated')}</span></div>`;

      // transiciones recientes: resalta nodos activos
      const recent = k.log.slice(-12);
      const hot = new Set();
      for (const e of recent) {
        if (e.type === 'admit') hot.add('ready');
        if (e.type === 'dispatch') hot.add('running');
        if (e.type === 'wait' || e.type === 'io') hot.add('blocked');
        if (e.type === 'sched') hot.add('ready');
        if (e.type === 'kill') hot.add('terminated');
      }
      pipes.innerHTML = `
        ${['new', 'ready', 'running', 'blocked', 'suspended', 'terminated'].map((s) => `
          <div class="pipe-node ${hot.has(s) ? 'hot' : ''}" data-s="${s}"><b>${sc[s]}</b><small>${getStateEs(s)}</small></div>
          <span class="pipe-arrow">→</span>`).join('')}
        <div class="pipe-node hot"><b>${k.ticks}</b><small>tick núcleo</small></div>`;

      // semáforos
      sems.innerHTML = Object.entries(k.semaphores).map(([id, s]) => {
        const waiting = s.waiting.length ? ` · esperan: PID ${s.waiting.join(', ')}` : '';
        return `<div><span class="k">sem ${id} = ${s.value}</span><span class="v">${waiting || '—'}</span></div>`;
      }).join('') + `<div><span class="k">operaciones P/V</span><span class="v">${k.metrics.semWaitOps} / ${k.metrics.semSignalOps}</span></div>`;
      buf.innerHTML = k.buffer.map((x, i) =>
        `<div class="buf-slot ${x ? 'filled' : ''}" title="buffer[${i}]">${x ? x.item : 'buffer[' + i + ']<br>vacío'}</div>`).join('');

      // log
      logBox.innerHTML = k.log.slice().reverse().slice(0, 120).map((e) =>
        `<div class="logline lk-${e.type}"><span class="lt">t${e.tick}</span>[${e.type}] ${e.text}</div>`).join('');
    });
  },
};

/* ============================================================
   7) AJUSTES DEL SIMULADOR
   ============================================================ */
const AppSettings = {
  name: 'Ajustes',
  icon: '⚙️',
  w: 680, h: 640,
  launch(body, win) {
    const k = OSApp.kernel;
    const f = (label, id, value, hint) => `
      <div class="form-row"><label>${label}</label>
      <div style="display:flex;gap:10px;align-items:center">
        <input type="range" id="${id}" min="60" max="1200" step="20" value="${value}" style="flex:1" class="aero-slider">
        <b id="${id}-v" style="min-width:64px">${value}</b>
      </div>${hint ? `<small style="color:var(--muted)">${hint}</small>` : ''}</div>`;

    // Wallpapers predefinidos Frutiger Aero
    const builtInWallpapers = [
      { id: 'aurora', name: 'Aurora Boreal', preview: 'linear-gradient(135deg, #003d6b 0%, #0078d7 35%, #00b294 70%, #2ecc71 100%)', css: 'linear-gradient(135deg, #003d6b 0%, #0078d7 35%, #00b294 70%, #2ecc71 100%)', animated: true },
      { id: 'sunset', name: 'Atardecer', preview: 'linear-gradient(135deg, #ff6b35 0%, #ff9f1c 50%, #ffd600 100%)', css: 'linear-gradient(135deg, #ff6b35 0%, #ff9f1c 50%, #ffd600 100%)', animated: true },
      { id: 'ice', name: 'Glaciar', preview: 'linear-gradient(135deg, #e8f4fd 0%, #a8d0e6 50%, #4da8da 100%)', css: 'linear-gradient(135deg, #e8f4fd 0%, #a8d0e6 50%, #4da8da 100%)', animated: true },
      { id: 'ocean', name: 'Océano Profundo', preview: 'linear-gradient(135deg, #001f3f 0%, #003d6b 40%, #0078d7 70%, #00b294 100%)', css: 'linear-gradient(135deg, #001f3f 0%, #003d6b 40%, #0078d7 70%, #00b294 100%)', animated: true },
      { id: 'forest', name: 'Bosque', preview: 'linear-gradient(135deg, #0d2818 0%, #1a4d2e 40%, #2ecc71 70%, #8ce071 100%)', css: 'linear-gradient(135deg, #0d2818 0%, #1a4d2e 40%, #2ecc71 70%, #8ce071 100%)', animated: true },
      { id: 'violet', name: 'Crepúsculo', preview: 'linear-gradient(135deg, #1a0d2e 0%, #2d1b4e 40%, #6c5ce7 70%, #a29bfe 100%)', css: 'linear-gradient(135deg, #1a0d2e 0%, #2d1b4e 40%, #6c5ce7 70%, #a29bfe 100%)', animated: true },
      { id: 'dark', name: 'Noche Oscura', preview: 'linear-gradient(145deg, #0a0f22 0%, #05070f 60%)', css: 'linear-gradient(145deg, #0a0f22 0%, #05070f 60%)', animated: false },
      { id: 'custom', name: 'Personalizada', preview: '', css: '', animated: false },
    ];

    // Cargar wallpaper guardado
    const savedWP = localStorage.getItem('simsys_wallpaper') || 'aurora';
    const savedCustom = localStorage.getItem('simsys_custom_wallpaper') || '';

    function applyWallpaper(wpId, customCss = '') {
      const wp = builtInWallpapers.find(w => w.id === wpId) || builtInWallpapers[0];
      const wallpaperEl = $('#wallpaper');
      if (!wallpaperEl) return;
      
      if (wpId === 'custom' && customCss) {
        wallpaperEl.style.background = customCss;
        wallpaperEl.style.backgroundSize = 'cover';
        wallpaperEl.style.backgroundPosition = 'center';
        wallpaperEl.style.animation = 'none';
      } else {
        wallpaperEl.style.background = wp.css;
        wallpaperEl.style.backgroundSize = wp.animated ? '400% 400%' : 'cover';
        wallpaperEl.style.backgroundPosition = 'center';
        wallpaperEl.style.animation = wp.animated ? 'auroraShift 25s ease infinite reverse' : 'none';
      }
      // Mantener el ruido sutil
      if (!wallpaperEl.querySelector('::before')) {
        const style = document.createElement('style');
        style.textContent = `#wallpaper::before { content: ''; position: absolute; inset: 0; background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E"); opacity: 0.03; pointer-events: none; }`;
        document.head.appendChild(style);
      }
    }

    // Aplicar wallpaper actual al iniciar
    setTimeout(() => applyWallpaper(savedWP, savedCustom), 50);

    body.innerHTML = `<h2 class="app-title">⚙️ Ajustes del Sistema</h2>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
        <!-- Columna 1: Núcleo -->
        <div class="panel" style="grid-column:1">
          <h3>🧠 Núcleo Simulado</h3>
          ${f('Velocidad del reloj (ms/tick)', 'set-tick', k.cfg.tickMs)}
          <div class="form-row"><label>Umbral de inanición (ticks en LISTO)</label>
            <input type="number" id="set-starve" value="${k.cfg.starvationThreshold}" min="10" max="120" class="aero-input"></div>
          <div class="form-row"><label>Compactación automática</label>
            <label class="aero-toggle"><input type="checkbox" id="set-cpt" ${k.cfg.autoCompact ? 'checked' : ''}><span class="slider"></span></label></div>
          <div class="form-row"><label>Resolver interbloqueo auto.</label>
            <label class="aero-toggle"><input type="checkbox" id="set-dl" ${k.cfg.autoResolveDeadlock ? 'checked' : ''}><span class="slider"></span></label></div>
          <div class="form-row"><label>Prob. de petición de E/S</label>
            <input type="number" id="set-io" value="${k.cfg.ioChance}" min="0" max="0.3" step="0.01" class="aero-input"></div>
          <div class="form-row"><label>Prob. de petición de recursos</label>
            <input type="number" id="set-res" value="${k.cfg.resChance}" min="0" max="0.3" step="0.01" class="aero-input"></div>
          <button class="aero-btn aero-btn-primary" id="set-apply" style="width:100%;margin-top:8px">Aplicar ajustes del núcleo</button>
        </div>

        <!-- Columna 2: Personalización -->
        <div class="panel" style="grid-column:2;grid-row:1/span 2;display:flex;flex-direction:column">
          <h3>🎨 Personalización / Wallpaper</h3>
          
          <!-- Wallpapers predefinidos -->
          <div style="margin-bottom:16px">
            <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:8px">Wallpapers Frutiger Aero</label>
            <div id="wp-presets" style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">
              ${builtInWallpapers.filter(w => w.id !== 'custom').map(w => `
                <button class="wp-preset ${w.id === savedWP ? 'active' : ''}" data-wp="${w.id}" style="
                  aspect-ratio:16/9;border-radius:var(--radius-md);border:2px solid ${w.id === savedWP ? 'var(--aero-sky)' : 'var(--glass-border)'};
                  background:${w.preview};background-size:400% 400%;${w.animated ? 'animation:auroraShift 8s ease infinite;' : ''}
                  cursor:pointer;transition:all var(--transition-fast);position:relative;overflow:hidden;
                  box-shadow:inset 0 1px 0 var(--specular-white),var(--shadow-sm);">
                  <span style="position:absolute;bottom:4px;left:4px;right:4px;background:rgba(0,0,0,0.6);padding:2px 6px;border-radius:4px;font-size:9px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${w.name}</span>
                </button>
              `).join('')}
            </div>
          </div>

          <!-- Wallpaper personalizado -->
          <div style="border-top:1px solid var(--glass-border);padding-top:16px">
            <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:8px">Imagen personalizada (URL o archivo local)</label>
            <div style="display:flex;flex-direction:column;gap:8px">
              <input type="url" id="wp-custom-url" class="aero-input" placeholder="https://ejemplo.com/imagen.jpg" value="${savedWP === 'custom' ? savedCustom : ''}" style="font-size:12px">
              <input type="file" id="wp-custom-file" accept="image/*" style="display:none" class="aero-input">
              <div style="display:flex;gap:8px">
                <button class="aero-btn aero-btn-secondary" id="wp-custom-pick" style="flex:1">📁 Seleccionar archivo</button>
                <button class="aero-btn aero-btn-primary" id="wp-custom-apply" style="flex:1">✅ Aplicar URL</button>
              </div>
              <small style="color:var(--muted);font-size:10px">Formatos: JPG, PNG, WebP, GIF. La imagen se guarda en localStorage.</small>
            </div>
            
            <!-- Preview personalizado -->
            <div id="wp-custom-preview" class="aero-card" style="margin-top:12px;min-height:120px;display:${savedWP === 'custom' ? 'block' : 'none'};background:${savedCustom || 'var(--glass-bg)'};background-size:cover;background-position:center;position:relative;overflow:hidden">
              <div style="position:absolute;inset:0;background:rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;color:var(--aero-white);font-size:11px">Vista previa</div>
            </div>
          </div>
        </div>

        <!-- Info sistema (abajo izquierda) -->
        <div class="panel" id="about-sys" style="grid-column:1"></div>
      </div>`;

    body.querySelector('#set-tick').oninput = (e) => { body.querySelector('#set-tick-v').textContent = e.target.value; };
    body.querySelector('#set-apply').onclick = () => {
      k.cfg.tickMs = +body.querySelector('#set-tick').value;
      k.cfg.starvationThreshold = +body.querySelector('#set-starve').value;
      k.cfg.autoCompact = body.querySelector('#set-cpt').checked;
      k.cfg.autoResolveDeadlock = body.querySelector('#set-dl').checked;
      k.cfg.ioChance = +body.querySelector('#set-io').value;
      k.cfg.resChance = +body.querySelector('#set-res').value;
      OS.restartTimer();
      OS.toast('✔ ajustes del núcleo aplicados');
    };

    // Event listeners para wallpapers predefinidos
    body.querySelectorAll('.wp-preset').forEach(btn => {
      btn.onclick = () => {
        const wpId = btn.dataset.wp;
        body.querySelectorAll('.wp-preset').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        btn.style.borderColor = 'var(--aero-sky)';
        body.querySelector('#wp-custom-preview').style.display = 'none';
        applyWallpaper(wpId);
        localStorage.setItem('simsys_wallpaper', wpId);
        localStorage.removeItem('simsys_custom_wallpaper');
        OS.toast(`🎨 Wallpaper cambiado: ${builtInWallpapers.find(w => w.id === wpId).name}`);
      };
    });

    // Selector de archivo
    const fileInput = body.querySelector('#wp-custom-file');
    body.querySelector('#wp-custom-pick').onclick = () => fileInput.click();
    fileInput.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target.result;
        body.querySelector('#wp-custom-url').value = dataUrl;
        const preview = body.querySelector('#wp-custom-preview');
        preview.style.backgroundImage = `url(${dataUrl})`;
        preview.style.display = 'block';
      };
      reader.readAsDataURL(file);
    };

    // Aplicar URL personalizada
    body.querySelector('#wp-custom-apply').onclick = () => {
      const url = body.querySelector('#wp-custom-url').value.trim();
      if (!url) { OS.toast('⚠️ Ingresa una URL o selecciona un archivo', 'warn'); return; }
      
      // Activar preset "custom"
      body.querySelectorAll('.wp-preset').forEach(b => b.classList.remove('active'));
      body.querySelector('#wp-custom-preview').style.backgroundImage = `url(${url})`;
      body.querySelector('#wp-custom-preview').style.display = 'block';
      
      applyWallpaper('custom', `url(${url})`);
      localStorage.setItem('simsys_wallpaper', 'custom');
      localStorage.setItem('simsys_custom_wallpaper', url);
      OS.toast('🎨 Wallpaper personalizado aplicado');
    };

    // Preview en vivo al escribir URL
    let previewTimeout;
    body.querySelector('#wp-custom-url').addEventListener('input', (e) => {
      clearTimeout(previewTimeout);
      const url = e.target.value.trim();
      if (url && (url.startsWith('http') || url.startsWith('data:'))) {
        previewTimeout = setTimeout(() => {
          const preview = body.querySelector('#wp-custom-preview');
          preview.style.backgroundImage = `url(${url})`;
          preview.style.display = 'block';
        }, 500);
      }
    });

    window.osAPI.getAppInfo().then((i) => {
      body.querySelector('#about-sys').innerHTML = `<h3>Sistema</h3><div class="stat-lines">
        <div><span class="k">Electron</span><span class="v">${i.electron}</span></div>
        <div><span class="k">Chromium</span><span class="v">${i.chrome}</span></div>
        <div><span class="k">Node</span><span class="v">${i.node}</span></div>
        <div><span class="k">Procesos simulados creados</span><span class="v">${k.metrics.created}</span></div></div>`;
    });
  },
};

/* ============================================================
   WEB APPS MANAGER — Gestor de aplicaciones web instalables
   ============================================================ */
const AppWebAppsManager = {
  name: 'Gestor de Web Apps',
  icon: '📦',
  w: 900, h: 680,
  launch(body, win) {
    if (!navigator.onLine) {
      renderNoConnection(body);
      return;
    }

    const el = document.createElement('div');
    el.style.cssText = 'height:100%;overflow-y:auto;padding:16px;background:transparent;color:var(--text)';

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--glass-border)';
    header.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <h2 style="font-size:22px;font-weight:300">📦 Gestor de Web Apps</h2>
      </div>
      <p style="font-size:12px;color:var(--muted)">Instala y gestiona aplicaciones web (PWA, sitios, manifiestos) como apps nativas del escritorio</p>
    `;
    el.appendChild(header);

    // Sección: Instalar nueva app
    const installSection = document.createElement('div');
    installSection.className = 'aero-card';
    installSection.style.marginBottom = '20px';
    installSection.innerHTML = `
      <h3 style="font-size:14px;font-weight:600;margin-bottom:16px;color:var(--aero-sky-light)">➕ Instalar nueva Web App</h3>
      <div style="display:flex;flex-direction:column;gap:12px">
        <div>
          <label style="display:block;font-size:11px;margin-bottom:6px;color:var(--muted)">URL de la web o manifiesto (.json)</label>
          <input type="url" id="webapp-url" class="aero-input" placeholder="https://ejemplo.com o https://ejemplo.com/manifest.json" style="font-size:13px">
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button id="btn-install-url" class="aero-btn aero-btn-primary" style="flex:1;min-width:140px">🌐 Instalar desde URL</button>
          <button id="btn-install-manifest" class="aero-btn aero-btn-secondary" style="flex:1;min-width:140px">📋 Instalar desde Manifiesto</button>
          <button id="btn-install-clipboard" class="aero-btn aero-btn-accent" style="flex:1;min-width:140px">📋 Desde portapapeles</button>
        </div>
        <div style="font-size:10px;color:var(--muted)">Compatible con Web App Manifest (W3C), PWA y cualquier sitio web</div>
      </div>
    `;
    el.appendChild(installSection);

    // Sección: Apps instaladas
    const listSection = document.createElement('div');
    listSection.innerHTML = `
      <h3 style="font-size:14px;font-weight:600;margin-bottom:12px;color:var(--aero-sky-light)">📱 Apps instaladas (<span id="webapp-count">0</span>)</h3>
      <div id="webapp-list" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px"></div>
    `;
    el.appendChild(listSection);

    // Sección: Acciones globales
    const actionsSection = document.createElement('div');
    actionsSection.className = 'aero-card';
    actionsSection.style.marginTop = '20px';
    actionsSection.innerHTML = `
      <h3 style="font-size:14px;font-weight:600;margin-bottom:16px;color:var(--aero-sky-light)">⚙️ Herramientas</h3>
      <div style="display:flex;flex-direction:column;gap:10px">
        <button id="btn-export-apps" class="aero-btn aero-btn-secondary" style="justify-content:flex-start">📤 Exportar apps (backup JSON)</button>
        <button id="btn-import-apps" class="aero-btn aero-btn-secondary" style="justify-content:flex-start">📥 Importar apps (desde JSON)</button>
        <input type="file" id="import-file" accept=".json" style="display:none">
        <button id="btn-clear-all" class="aero-btn aero-btn-danger" style="justify-content:flex-start">🗑️ Eliminar todas las Web Apps</button>
      </div>
    `;
    el.appendChild(actionsSection);

    // Renderizar lista inicial
    renderAppList();

    // Event listeners
    installSection.querySelector('#btn-install-url').addEventListener('click', async () => {
      const url = installSection.querySelector('#webapp-url').value.trim();
      if (!url) return;
      await installWebApp(url);
    });

    installSection.querySelector('#btn-install-manifest').addEventListener('click', async () => {
      const url = installSection.querySelector('#webapp-url').value.trim();
      if (!url) return;
      await installWebApp(url, { fromManifest: true });
    });

    installSection.querySelector('#btn-install-clipboard').addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text && /^https?:\/\//i.test(text.trim())) {
          installSection.querySelector('#webapp-url').value = text.trim();
          await installWebApp(text.trim());
        } else {
          OS.toast('⚠️ No hay una URL válida en el portapapeles', 'warn');
        }
      } catch (e) {
        OS.toast('⚠️ No se pudo leer el portapapeles', 'warn');
      }
    });

    actionsSection.querySelector('#btn-export-apps').addEventListener('click', () => {
      WebAppManager.exportToFile();
    });

    actionsSection.querySelector('#btn-import-apps').addEventListener('click', () => {
      actionsSection.querySelector('#import-file').click();
    });

    actionsSection.querySelector('#import-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const results = await WebAppManager.importFromFile(file);
        const success = results.filter(r => r.success).length;
        OS.toast(`📥 Importación completa: ${success} de ${results.length} apps importadas`);
        renderAppList();
      } catch (err) {
        OS.toast('⚠️ Error al importar: ' + err.message, 'error');
      }
      e.target.value = '';
    });

    actionsSection.querySelector('#btn-clear-all').addEventListener('click', () => {
      const apps = WebAppManager.getInstalledApps();
      if (!apps.length) return;

      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);z-index:9999;display:flex;align-items:center;justify-content:center';
      overlay.innerHTML = `
        <div class="aero-card" style="max-width:360px;width:90%;padding:24px;text-align:center">
          <div style="font-size:48px;margin-bottom:16px">⚠️</div>
          <h3 style="margin-bottom:8px">Eliminar todas las Web Apps</h3>
          <p style="color:var(--muted);margin-bottom:20px;font-size:13px">Se eliminarán <strong>${apps.length}</strong> apps instaladas. Esta acción no se puede deshacer.</p>
          <div style="display:flex;gap:10px;justify-content:center">
            <button class="aero-btn aero-btn-secondary" id="cancel-clear">Cancelar</button>
            <button class="aero-btn aero-btn-danger" id="confirm-clear">Eliminar todo</button>
          </div>
        </div>
      `;
      overlay.querySelector('#cancel-clear').addEventListener('click', () => overlay.remove());
      overlay.querySelector('#confirm-clear').addEventListener('click', () => {
        for (const app of apps) {
          WebAppManager.uninstall(app.id);
        }
        renderAppList();
        overlay.remove();
      });
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
      document.body.appendChild(overlay);
    });

    // Función auxiliar para instalar
    async function installWebApp(url, options = {}) {
      const btn = installSection.querySelector('#btn-install-url');
      const originalText = btn.textContent;
      btn.textContent = '⏳ Instalando...';
      btn.disabled = true;

      try {
        let result;
        if (options.fromManifest || url.endsWith('.json')) {
          result = await WebAppManager.installFromManifest(url);
        } else {
          result = await WebAppManager.installFromUrl(url);
        }
        OS.toast(`✅ Web App instalada: "${result.app.name}"`);
        installSection.querySelector('#webapp-url').value = '';
        renderAppList();
      } catch (err) {
        OS.toast('⚠️ Error al instalar: ' + err.message, 'error');
      } finally {
        btn.textContent = originalText;
        btn.disabled = false;
      }
    }

    // Renderizar lista de apps instaladas
    function renderAppList() {
      const list = el.querySelector('#webapp-list');
      const countEl = el.querySelector('#webapp-count');
      const apps = WebAppManager.getInstalledApps();

      countEl.textContent = apps.length;

      if (apps.length === 0) {
        list.innerHTML = `
          <div class="aero-card" style="grid-column:1/-1;text-align:center;padding:40px 20px">
            <div style="font-size:48px;margin-bottom:12px">📦</div>
            <h4 style="font-weight:300;margin-bottom:8px">No hay Web Apps instaladas</h4>
            <p style="font-size:11px;color:var(--muted)">Instala tu primera app web usando el formulario de arriba</p>
          </div>
        `;
        return;
      }

      list.innerHTML = apps.map(app => `
        <div class="aero-card webapp-item" data-app-id="${app.id}" style="display:flex;flex-direction:column;gap:10px;animation:fadeInUp 0.3s ease-out backwards">
          <div style="display:flex;align-items:flex-start;gap:12px">
            <div style="width:52px;height:52px;border-radius:12px;background:${app.themeColor || '#00b294'};display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0;box-shadow:0 2px 8px rgba(0,0,0,0.2),inset 0 1px 0 rgba(255,255,255,0.2)">
              ${app.icon.startsWith('http') || app.icon.startsWith('data:') ? `<img src="${app.icon}" style="width:34px;height:34px;border-radius:6px">` : app.icon}
            </div>
            <div style="flex:1;min-width:0">
              <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${app.name}</div>
              <div style="font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${app.startUrl}</div>
              <div style="font-size:9px;color:var(--muted);margin-top:4px">Instalada: ${new Date(app.installedAt).toLocaleDateString()}</div>
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
            <button class="aero-btn aero-btn-primary btn-open" data-app-id="${app.id}" style="flex:1;min-width:0;font-size:11px;padding:8px 10px">▶️ Abrir</button>
            <button class="aero-btn aero-btn-secondary btn-shortcut" data-app-id="${app.id}" style="flex:1;min-width:0;font-size:11px;padding:8px 10px">📌 Acceso directo</button>
            <button class="aero-btn aero-btn-danger btn-uninstall" data-app-id="${app.id}" style="flex:1;min-width:0;font-size:11px;padding:8px 10px">🗑️</button>
          </div>
        </div>
      `).join('');

      // Event listeners para botones de la lista
      list.querySelectorAll('.btn-open').forEach(btn => {
        btn.addEventListener('click', () => {
          WebAppManager.openApp(btn.dataset.appId);
        });
      });

      list.querySelectorAll('.btn-shortcut').forEach(btn => {
        btn.addEventListener('click', () => {
          const app = WebAppManager.getApp(btn.dataset.appId);
          if (app) {
            OS.toast(`📌 "${app.name}" ya está en el menú Inicio`);
          }
        });
      });

      list.querySelectorAll('.btn-uninstall').forEach(btn => {
        btn.addEventListener('click', () => {
          const app = WebAppManager.getApp(btn.dataset.appId);
          if (app) {
            WebAppManager.confirmUninstall(btn.dataset.appId);
          }
        });
      });
    }

    body.appendChild(el);
  }
};

// Función para renderizar sin conexión
function renderNoConnection(body) {
  body.innerHTML = `
    <div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:var(--text);text-align:center;padding:22px;box-sizing:border-box">
      <div style="font-size:60px">📡</div>
      <h2 style="font-size:18px;font-weight:300">Sin conexión</h2>
      <p style="font-size:12px;color:var(--muted)">Esta aplicación necesita internet para instalar Web Apps.</p>
      <button class="aero-btn aero-btn-primary" onclick="location.reload()">Reintentar</button>
    </div>
  `;
}

/* ====================== registrar apps =================== */
var Apps = [AppProcess, AppMemory, AppResources, AppFiles, AppTerminal, AppSync, AppSettings, AppWebAppsManager];

/* ============================================================
   DIÁLOGO: crear proceso
   ============================================================ */
function createProcessDialog(onDone) {
  const k = OSApp.kernel;
  const layer = $('#modal-layer');
  layer.innerHTML = '';
  layer.classList.remove('hidden');
  const icons = ['🧩', '🚀', '🎮', '🎨', '📎', '📦', '🛰️', '🧪', '🎵', '📕'];
  layer.innerHTML = `
    <div class="dialog">
      <div class="d-head">➕ Crear nuevo proceso</div>
      <div class="d-body">
        <div class="form-row"><label>Nombre</label><input id="np-name" value="proceso-usuario-${k.nextPid}"></div>
        <div class="form-row"><label>Icono</label><select id="np-icon">${icons.map((i) => `<option>${i}</option>`).join('')}</select></div>
        <div class="form-row"><label>Prioridad (0-10)</label><input id="np-prio" type="number" min="0" max="10" value="4"></div>
        <div class="form-row"><label>Quantum (ticks)</label><input id="np-q" type="number" min="1" max="12" value="${k.cfg.quantumBase}"></div>
        <div class="form-row"><label>Ráfaga de CPU</label><input id="np-burst" type="number" min="5" max="200" value="${30 + Math.floor(Math.random() * 60)}"></div>
        <div class="form-row"><label>Memoria (MB)</label><input id="np-mem" type="number" min="8" max="240" value="${16 + Math.floor(Math.random() * 100)}"></div>
        <small style="color:var(--muted)">El Xplano (RPC/Round-Robin) le asignará CPU cuando corresponda; si hace peticiones de E/S podrá bloquearse, y ante recursos escasos podría participar de un interbloqueo.</small>
      </div>
      <div class="d-foot">
        <button id="np-cancel">Cancelar</button>
        <button id="np-ok" class="primary">Crear proceso</button>
      </div>
    </div>`;
  layer.querySelector('#np-cancel').onclick = () => { layer.classList.add('hidden'); layer.innerHTML = ''; onDone && onDone(false); };
  layer.querySelector('#np-ok').onclick = () => {
    const p = OS.kernel.createProcess({
      name: layer.querySelector('#np-name').value || 'sin-nombre',
      icon: layer.querySelector('#np-icon').value,
      priority: +layer.querySelector('#np-prio').value,
      quantum: +layer.querySelector('#np-q').value,
      burst: +layer.querySelector('#np-burst').value,
      mem: +layer.querySelector('#np-mem').value,
    });
    layer.classList.add('hidden');
    layer.innerHTML = '';
    OS.toast(`${p.icon} proceso creado: ${p.name} (PID ${p.pid})`);
    onDone && onDone(true, p);
  };
}

/* ============================================================
   DIÁLOGO: grafo de espera / interbloqueo
   ============================================================ */
function showWaitGraph() {
  const k = OSApp.kernel;
  const layer = $('#modal-layer');
  layer.innerHTML = '';
  layer.classList.remove('hidden');
  const dl = k.deadlock;
  const waits = k.processes.filter((p) => p.deviceWanted);
  const holds = new Map();
  for (const p of k.processes) {
    for (const h of p.devicesHeld) {
      const d = k._device(h.devId);
      if (!holds.has(d.id)) holds.set(d.id, []);
      holds.get(d.id).push(p);
    }
  }
  let edges = '';
  for (const p of waits) {
    const d = k._device(p.deviceWanted);
    edges += `<div class="hw-line"><span class="k">PID ${p.pid} ${p.icon}</span><span class="v">espera ${d?.icon}${d?.name}</span></div>`;
    for (const holder of holds.get(p.deviceWanted) || []) {
      if (holder.pid === p.pid) continue;
      edges += `<div class="hw-line"><span class="k">&nbsp;&nbsp;↳ poseído por</span><span class="v" style="color:${dl.active && dl.cycle.includes(holder.pid) ? 'var(--danger)' : 'inherit'}">PID ${holder.pid} (${holder.name})</span></div>`;
    }
  }
  const cycleTxt = dl.active
    ? `<b style="color:var(--danger)">⚠ ¡INTERBLOQUEO EXISTENTE! Ciclo de espera circular entre PIDs: ${dl.cycle.join(' ⇄ ')}</b>`
    : '<b style="color:var(--accent2)">sin espera circular en este momento (estado estable)</b>';
  layer.innerHTML = `
    <div class="dialog ${dl.active ? 'danger' : ''}">
      <div class="d-head">🚨 Grafo de asignación de recursos</div>
      <div class="d-body">
        <div class="panel" style="margin-bottom:10px">${cycleTxt}</div>
        ${edges ? edges : '<i style="color:var(--muted)">sin esperas en este momento</i>'}
      </div>
      <div class="d-foot">
        ${dl.active ? '<button id="wg-resolve" class="primary">🧨 Resolver (abortar víctima)</button>' : ''}
        <button id="wg-close">Cerrar</button>
      </div>
    </div>`;
  layer.querySelector('#wg-close').onclick = () => { layer.classList.add('hidden'); layer.innerHTML = ''; };
  const rb = layer.querySelector('#wg-resolve');
  if (rb) rb.onclick = () => { OS.kernel.resolveDeadlock(null); layer.classList.add('hidden'); layer.innerHTML = ''; OS.toast('✔ interbloqueo resuelto: víctima abortada y recursos liberados'); };
}
