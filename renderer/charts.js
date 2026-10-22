// ============================================================
// SimSys OS — utilidades de gráficas sobre <canvas>
// ============================================================
(function () {
  'use strict';

  const COLORS = [
    '#4f8cff', '#43d17a', '#ffb84f', '#ff5f6d', '#b06cf5',
    '#35c9c0', '#f56bb0', '#8bd450', '#f59a3f', '#6fa8ff',
    '#c3e88d', '#ff8f6b', '#7ee3ff', '#e0b0ff', '#ffd479',
  ];
  const Chart = { colors: () => COLORS.slice(), colorFor: (i) => COLORS[((i % COLORS.length) + COLORS.length) % COLORS.length] };

  // Dimensiona el mapa de bits del canvas (resolución). El tamaño VISIBLE
  // lo controla el CSS (width/height style), de modo que el canvas nunca
  // modifica la disposición de la ventana al redibujar ni al redimensionar.
  function fitCanvas(canvas, width, height) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(10, Math.round(width * dpr));
    canvas.height = Math.max(10, Math.round(height * dpr));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  // Gráfica de líneas: series = [{name, color, data:[{t,v}]}]
  // El ancho visible lo da CSS (width:100%); aquí solo se lee clientWidth.
  function lineChart(canvas, series, opts = {}) {
    const w = Math.round(canvas.clientWidth) || Math.max(80, opts.width || 420);
    const h = Math.round(canvas.clientHeight) || Math.max(60, opts.height || 180);
    if (w <= 40 || h <= 40) return; // ventana minimizada/oculta: no dibujar
    const ctx = fitCanvas(canvas, w, h);
    ctx.clearRect(0, 0, w, h);

    const padL = 34, padR = 8, padT = 10, padB = 18;
    const cw = w - padL - padR, ch = h - padT - padB;
    let maxT = 0, maxV = 0;
    for (const s of series) for (const d of s.data) { maxT = Math.max(maxT, d.t); maxV = Math.max(maxV, d.v); }
    if (maxV <= 0) maxV = 1;
    maxV *= 1.15;

    // rejilla
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '10px system-ui';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padT + (ch * i) / 4;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + cw, y);
      ctx.stroke();
      ctx.fillText(Math.round(maxV - (maxV * i) / 4), 4, y + 3);
    }

    if (!series.length || !maxT) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillText('sin datos aún…', padL + cw / 2 - 30, padT + ch / 2);
      return;
    }

    const minT = Math.max(0, maxT - (opts.window || 200));
    const x = (t) => padL + cw * ((t - minT) / Math.max(1, maxT - minT));
    const y = (v) => padT + ch - (v / maxV) * ch;

    for (const s of series) {
      ctx.strokeStyle = s.color || '#4f8cff';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      let pen = false;
      for (const d of s.data) {
        if (d.t < minT) continue;
        if (!pen) { ctx.moveTo(x(d.t), y(d.v)); pen = true; }
        else ctx.lineTo(x(d.t), y(d.v));
      }
      ctx.stroke();
    }

    // leyenda
    ctx.font = '10px system-ui';
    let lx = padL;
    for (const s of series) {
      ctx.fillStyle = s.color || '#4f8cff';
      ctx.fillRect(lx, h - 9, 8, 8);
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillText(s.name, lx + 11, h - 2);
      lx += 14 + ctx.measureText(s.name).width;
    }
  }

  // Gráfica de barras: items = [{name, value, color, badge}]
  function barChart(canvas, items, opts = {}) {
    const w = Math.round(canvas.clientWidth) || Math.max(80, opts.width || 420);
    const h = Math.round(canvas.clientHeight) || (opts.height || 200);
    if (w <= 40 || h <= 40) return;
    const ctx = fitCanvas(canvas, w, h);
    ctx.clearRect(0, 0, w, h);
    if (!items.length) return;
    const padL = 90, padR = 36, padT = 8, rowH = Math.min(26, (h - padT - 8) / items.length);
    const cw = w - padL - padR;
    const maxV = opts.maxV || Math.max(1, ...items.map((i) => i.value));
    ctx.font = '11px system-ui';
    items.forEach((it, i) => {
      const y = padT + rowH * i + 4;
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillText(it.name.slice(0, 14), 2, y + 9);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(padL, y, cw, 13);
      const bw = Math.max(0, Math.min(cw, (it.value / maxV) * cw));
      ctx.fillStyle = it.color || '#4f8cff';
      ctx.fillRect(padL, y, bw, 13);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      const label = it.text ?? `${Math.round(it.value)}${opts.suffix || ''}`;
      ctx.fillText(label, padL + bw + 4, y + 10.5);
    });
  }

  // Franja tipo Gantt: segmentos = [{pid, core, tick}], pids = [pid...]
  function ganttStrip(canvas, segments, processes, windowSize) {
    const w = Math.round(canvas.clientWidth) || 420;
    if (w <= 40) return; // ventana minimizada/oculta: no dibujar
    const h = 56 + (processes.length ? Math.min(processes.length, 14) * 13 : 0);
    if (Math.round(canvas.clientHeight) !== h) canvas.style.height = h + 'px'; // solo cambia con el nº de filas
    const ctx = fitCanvas(canvas, w, h);
    ctx.clearRect(0, 0, w, h);
    if (!segments.length) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillText('sin actividad en CPU aún…', 10, 30);
      return;
    }
    const lastTick = segments[segments.length - 1].tick;
    const from = Math.max(0, lastTick - (windowSize || 120));
    const rows = processes.slice(0, 14); // [{pid,name}]
    const map = new Map(rows.map((p, i) => [p.pid, i]));
    const rowH = (h - 46) / Math.max(1, rows.length);
    ctx.font = '10px system-ui';
    // ejes de tiempo
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath();
    ctx.moveTo(0, 40); ctx.lineTo(w, 40); ctx.stroke();
    for (let i = 0; i <= 6; i++) {
      const t = Math.round(from + ((lastTick - from) * i) / 6);
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillText('t=' + t, (w * i) / 6, 52);
    }
    for (const seg of segments) {
      const row = map.get(seg.pid);
      if (row === undefined || seg.tick < from) continue;
      const x = ((seg.tick - from) / Math.max(1, lastTick - from)) * w;
      const bw = w / Math.max(1, lastTick - from);
      ctx.fillStyle = Chart.colorFor(rows.findIndex((r) => r.pid === seg.pid));
      ctx.fillRect(x, 8 + row * rowH, Math.max(2, bw), 10);
    }
    rows.forEach((p, i) => {
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillText(`PID ${p.pid}`, 2, 8 + rowH * i + 9);
    });
  }

  // Dona: slices = [{value, color, label}]
  function donutChart(canvas, slices, opts = {}) {
    const size = Math.round(canvas.clientWidth) || opts.size || 160;
    if (size <= 40) return;
    const ctx = fitCanvas(canvas, size, size);
    const cx = size / 2, cy = size / 2, r = size / 2 - 6;
    const total = slices.reduce((a, s) => a + s.value, 0);
    ctx.lineWidth = 16;
    if (!total) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.strokeStyle='rgba(255,255,255,0.1)'; ctx.stroke(); return; }
    let a0 = -Math.PI / 2;
    for (const s of slices) {
      const frac = s.value / total;
      if (frac <= 0) continue;
      ctx.beginPath();
      ctx.arc(cx, cy, r, a0, a0 + frac * Math.PI * 2);
      ctx.strokeStyle = s.color;
      ctx.stroke();
      a0 += frac * Math.PI * 2;
    }
  }

  Chart.lineChart = lineChart;
  Chart.barChart = barChart;
  Chart.ganttStrip = ganttStrip;
  Chart.donutChart = donutChart;
  Chart.fitCanvas = fitCanvas;
  window.Chart = Chart;
})();
