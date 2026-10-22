// ==========================================================================
// SimSys OS — KERNEL SIMULADO
// Motor de simulación: planificación de procesos (Round-Robin con quantum
// por proceso + prioridades), administración de memoria por particiones
// dinámicas con COMPACTACIÓN y fragmentación interna/externa, administración
// de DISCO DURO y dispositivos de E/S, detección de INTERBLOQUEO (ciclos en
// el grafo de asignación de recursos), INANICIÓN (envejecimiento / aging),
// sincronización con semáforos (productor-consumidor) y registro de eventos.
//
// El motor es agnóstico del DOM: puede ejecutarse en el navegador
// (Electron) o en Node para pruebas automáticas.
// ==========================================================================
(function (root, factory) {
  // En Node puro (pruebas headless) exporta por CommonJS; en el navegador
  // SIEMPRE publica el global `Kernel`, aunque exista `module` (Electron con
  // nodeIntegration:true define module en el renderer).
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') module.exports = factory();
  else root.Kernel = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const rand = (n) => Math.floor(Math.random() * n);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const STATES = {
    NEW: 'new',
    READY: 'ready',
    RUNNING: 'running',
    BLOCKED: 'blocked',
    SUSPENDED: 'suspended',
    TERMINATED: 'terminated',
  };
  const STATE_ES = {
    new: 'Nuevo',
    ready: 'Listo',
    running: 'Ejecución',
    blocked: 'Bloqueado',
    suspended: 'Suspendido',
    terminated: 'Terminado',
  };

  // ------------------------------ DISPOSITIVOS ------------------------------
  const DEVICE_DEFS = [
    { id: 'disk', name: 'Disco Duro', icon: '💽', instances: 1 },
    { id: 'printer', name: 'Impresora', icon: '🖨️', instances: 2 },
    { id: 'scanner', name: 'Escáner', icon: '📠', instances: 1 },
    { id: 'camera', name: 'Cámara Web', icon: '📷', instances: 1 },
    { id: 'net', name: 'Interfaz de Red', icon: '🌐', instances: 1 },
  ];

  // ------------------------- PROCESOS INICIALES (≥ 10) ----------------------
  const INITIAL_PROCESSES = [
    { name: 'init (inicio del sistema)', icon: '⚙️', burst: 14, priority: 9, mem: 24, quantum: 5, io: ['disk'], kind: 'system' },
    { name: 'rtkernel (núcleo en tiempo real)', icon: '🛡️', burst: 95, priority: 10, mem: 120, quantum: 6, io: [], kind: 'system' },
    { name: 'antivirus (escaneo)', icon: '🦠', burst: 80, priority: 5, mem: 160, quantum: 3, io: ['disk'], kind: 'app' },
    { name: 'indexador-archivos', icon: '🔍', burst: 60, priority: 4, mem: 88, quantum: 4, io: ['disk', 'scanner'], kind: 'app' },
    { name: 'compositor (gestor de ventanas)', icon: '🪟', burst: 120, priority: 8, mem: 96, quantum: 5, io: [], kind: 'system' },
    { name: 'servicio-red', icon: '🌐', burst: 90, priority: 6, mem: 56, quantum: 4, io: ['net'], kind: 'service' },
    { name: 'reproductor-multimedia', icon: '🎬', burst: 100, priority: 7, mem: 200, quantum: 4, io: ['camera'], kind: 'app' },
    { name: 'editor-texto', icon: '📝', burst: 45, priority: 3, mem: 64, quantum: 4, io: ['printer'], kind: 'app' },
    { name: 'telemetria', icon: '📈', burst: 70, priority: 2, mem: 40, quantum: 3, io: ['net'], kind: 'service' },
    { name: 'cola-impresion', icon: '🖨️', burst: 50, priority: 3, mem: 32, quantum: 4, io: ['printer', 'disk'], kind: 'service' },
    { name: 'backup-nocturno', icon: '💾', burst: 85, priority: 1, mem: 110, quantum: 2, io: ['disk'], kind: 'service' },
    { name: 'asistente-ia', icon: '🤖', burst: 90, priority: 5, mem: 150, quantum: 4, io: ['net'], kind: 'app' },
    { name: 'productor-datos', icon: '📦', burst: 70, priority: 4, mem: 48, quantum: 4, io: [], kind: 'producer' },
    { name: 'consumidor-datos', icon: '🧺', burst: 70, priority: 4, mem: 48, quantum: 4, io: [], kind: 'consumer' },
  ];

  // ------------------------------ KERNEL -----------------------------------
  function Kernel(cfg = {}) {
    this.cfg = Object.assign(
      {
        cores: 2,
        memTotal: 1024, // MB
        blockSize: 8, // MB por bloque (granularidad → fragmentación interna)
        quantumBase: 4,
        tickMs: 250,
        starvationThreshold: 25, // ticks en LISTO antes de declarar inanición
        autoCompact: true,
        autoResolveDeadlock: true, // ante interbloqueo: aborta a la víctima de menor prioridad
        ioChance: 0.05,
        resChance: 0.035,
      },
      cfg
    );

    this.ticks = 0;
    this.paused = true;
    this.nextPid = 1;
    this.processes = [];
    this.cores = Array.from({ length: this.cfg.cores }, (_, i) => ({ idx: i, pid: null }));
    this.log = []; // eventos {tick, type, text}
    this.metrics = {
      contextSwitches: 0,
      deadlocksDetected: 0,
      deadlocksResolved: 0,
      compactations: 0,
      admissions: 0,
      semWaitOps: 0,
      semSignalOps: 0,
      starved: 0,
      created: 0,
      terminated: 0,
    };
    this.history = { cpu: [], mem: [], io: [], ganttPts: [] }; // datos de gráficas
    this.deadlock = { active: false, cycle: [], resolvedWith: null };

    // Semáforos (sincronización de procesos) — buffer compartido de 5 huecos
    this.semaphores = {
      mutex: { value: 1, waiting: [] },
      empty: { value: 5, waiting: [] },
      full: { value: 0, waiting: [] },
    };
    this.buffer = [null, null, null, null, null];

    // Dispositivos de E/S con N instancias
    this.devices = DEVICE_DEFS.map((d) => ({
      id: d.id,
      name: d.name,
      icon: d.icon,
      instances: d.instances,
      allocated: new Array(d.instances).fill(null),
      queue: [],
    }));

    // Disco duro simulado
    this.disk = { totalMB: 40 * 1024, usedMB: 12 * 1024, files: [] };

    // Memoria: array de bloques; null = hueco (fragmentación externa)
    this.memBlocks = new Array(this.cfg.memTotal / this.cfg.blockSize).fill(null);
    this.strategy = 'first'; // first | best
    this._initBasicFiles();
    this._initFS(); // sistema de archivos navigable (/home, /etc, /proc…)
  }

  function range(start, n) {
    const out = [];
    for (let k = 0; k < n; k++) out.push(start + k);
    return out;
  }

  Kernel.prototype._initBasicFiles = function () {
    const sys = [
      { name: 'kernel.sys', owner: 0, ownerName: 'sistema', sizeMB: 42 },
      { name: ' paginacion.dat ', owner: 0, ownerName: 'sistema', sizeMB: 18 },
      { name: 'registro-eventos.log', owner: 0, ownerName: 'sistema', sizeMB: 6 },
      { name: 'swap.sys', owner: 0, ownerName: 'sistema', sizeMB: 510 },
      { name: ' fuentes.so.cfg ', owner: 0, ownerName: 'sistema', sizeMB: 2 },
    ];
    for (const f of sys) {
      f.name = f.name.trim();
      this.disk.files.push(f);
    }
  };

  // ---------------------- SISTEMA DE ARCHIVOS VIRTUAL -----------------------
  // Árbol jerárquico navegable desde la terminal y el explorador.
  // Los archivos 'virtuales' (en /proc y /var/log) generan su contenido
  // dinámicamente a partir del estado actual del núcleo.
  Kernel.prototype._initFS = function () {
    const D = (name, children = []) => ({ type: 'dir', name, children, owner: 0 });
    const F = (name, content, owner = 0, virtual = null) => ({ type: 'file', name, content, owner, virtual });
    this.fs = D('', [
      D('bin', []),
      D('etc', [
        F('motd', 'Bienvenido a SimSys OS — simulador académico.\nNavega con ls / cd, crea archivos con echo "texto" > archivo.txt'),
        F('hosts', '127.0.0.1  localhost\n127.0.1.1  simsys'),
        F('version', 'SimSys OS 1.0 — kernel simulado: Round-Robin por prioridades + quantums por proceso'),
      ]),
      D('home', [
        D('juan', [
          D('documentos', [
            F('apuntes-so.txt',
              'REPASO DE MATERIA (simulado en este SO)\n' +
              '- Planificación: Round-Robin con quantum por proceso y prioridades.\n' +
              '- Alternancia: el quantum agotado desaloja el proceso (context switch).\n' +
              '- Interbloqueo: espera circular en el grafo de recursos (mantener-y-esperar).\n' +
              '- Inanición: proceso listo desatendido; se corrige con envejecimiento (aging).\n' +
              '- Memoria: particiones dinámicas, first/best-fit, compactación.\n' +
              '- Fragmentación interna: redondeo a bloques; externa: huecos dispersos.'),
            F('comandos.txt',
              'COMANDOS DE LA TERMINAL:\n' +
              'ls  cd  pwd  cat  echo > archivo  mkdir  touch  rm  mv  tree  find  df'),
          ]),
          D('descargas', []),
          D('musica', []),
          D('fondos', [
            F('aurora-boreal.jpg', 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4MDAiIGhlaWdodD0iNjAwIj48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImciIHgxPSIwJSIgeTE9IjAlIiB4Mj0iMTAwJSIgeTI9IjEwMCUiPjxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiMwMDNkNmIiLz48c3RvcCBvZmZzZXQ9IjM1JSIgc3RvcC1jb2xvcj0iIzAwNzgwNyIvPjxzdG9wIG9mZnNldD0iNzAlIiBzdG9wLWNvbG9yPSIjMDBiMjk0Ii8+PHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjMmVjYzcxIi8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+PHJlY3Qgd2lkdGg9IjEwMCUiIGhlaWdodD0iMTAwJSIgZmlsbD0idXJsKCNnKSIvPjwvc3ZnPg==', 0, null, { isWallpaper: true, theme: 'aurora' }),
            F('atardecer.jpg', 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4MDAiIGhlaWdodD0iNjAwIj48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImciIHgxPSIwJSIgeTE9IjAlIiB4Mj0iMTAwJSIgeTI9IjEwMCUiPjxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiNmZjZiMzUiLz48c3RvcCBvZmZzZXQ9IjUwJSIgc3RvcC1jb2xvcj0iI2ZmOWYxYyIvPjxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iI2ZmZDYwMCIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9InVybCgjZykiLz48L3N2Zz4=', 0, null, { isWallpaper: true, theme: 'sunset' }),
            F('glaciar.jpg', 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4MDAiIGhlaWdodD0iNjAwIj48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImciIHgxPSIwJSIgeTE9IjAlIiB4Mj0iMTAwJSIgeTI9IjEwMCUiPjxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiNlOGY0ZmQiLz48c3RvcCBvZmZzZXQ9IjUwJSIgc3RvcC1jb2xvcj0iI2E4ZDBlNiIvPjxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iIzRkYThkYSIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9InVybCgjZykiLz48L3N2Zz4=', 0, null, { isWallpaper: true, theme: 'ice' }),
          ]),
          F('leeme.txt',
            'Crea un archivo:  echo "hola mundo" > prueba.txt\n' +
            'Místralo:         cat prueba.txt\n' +
            'Sube un nivel:    cd ..'),
        ]),
      ]),
      D('proc', [
        F('cpuinfo', null, 0, 'cpuinfo'),
        F('meminfo', null, 0, 'meminfo'),
        F('devices', null, 0, 'devices'),
        F('estado-nucleo', null, 0, 'kernel-stats'),
      ]),
      D('tmp', []),
      D('usr', [D('lib', []), D('share', [])]),
      D('var', [D('log', [F('kernel.log', null, 0, 'klog')])]),
    ]);
  };

  // Localiza un nodo a partir de las partes de la ruta (['home','juan'])
  Kernel.prototype.fsLookup = function (parts) {
    let node = this.fs;
    for (const p of parts) {
      if (!node || node.type !== 'dir') return null;
      node = node.children.find((c) => c.name === p) || null;
    }
    return node;
  };

  // Resuelve ruta absoluta (/…) o relativa (con . , .. y ~) desde cwd
  Kernel.prototype.fsResolvePath = function (cwd, target) {
    let parts = Array.isArray(cwd) ? cwd.slice() : [];
    if (target && target.startsWith('/')) parts = [];
    if (!target || target === '' || target === '.') return parts;
    for (const seg of String(target).split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '~') parts = ['home', 'juan'];
      else if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return parts;
  };

  // Contenido (expandido) de un archivo — los virtuales se generan al vuelo
  Kernel.prototype.fsFileContent = function (node) {
    if (!node || node.type !== 'file') return null;
    if (node.virtual === 'klog') return this.log.map((e) => `t${e.tick} [${e.type}] ${e.text}`).join('\n');
    if (node.virtual === 'cpuinfo') {
      return `processor       : ${this.cfg.cores} núcleos simulados\nmodel name      : SimCore RR-Q${this.cfg.quantumBase}\nplanificador    : Round-Robin por prioridades\nalternancias    : ${this.metrics.contextSwitches}\ntick actual     : ${this.ticks}\nfrecuencia      : ${Math.round(1000 / this.cfg.tickMs * 10) / 10} ticks/segundo`;
    }
    if (node.virtual === 'meminfo') {
      const st = this.memStats();
      return `MemTotal:  ${st.totalMB} MB\nMemUsada:  ${st.usedMB} MB (${st.usedPct.toFixed(1)} %)\nMemLibre:  ${st.freeMB} MB\nhuecos    : ${st.holes} (${st.holeBytes} MB)\nfragInterna: ${st.internalFragMB} MB\nfragExterna: ${st.fragExternaPct.toFixed(1)} %\ncompactaciones: ${this.metrics.compactations}`;
    }
    if (node.virtual === 'devices') {
      return this.devices
        .map((d) => `${d.name}: ${d.instances} instancia(s), asignadas=${d.allocated.filter((x) => x !== null).length}, espera=${d.queue.length}`)
        .join('\n');
    }
    if (node.virtual === 'kernel-stats') {
      const sc = this.stateCounts();
      const st = this.memStats();
      return `procesos: ${this.processes.length} (N${sc.new} L${sc.ready} E${sc.running} B${sc.blocked} S${sc.suspended} T${sc.terminated})\ncreados=${this.metrics.created} terminados=${this.metrics.terminated}\ninterbloqueos=${this.metrics.deadlocksDetected}/resueltos=${this.metrics.deadlocksResolved}\ncasosDeInanicion=${this.metrics.starved}\nmemoriaUsada=${st.usedMB}MB fragExt=${st.fragExternaPct.toFixed(1)}% fragInt=${st.internalFragMB}MB`;
    }
    return node.content;
  };

  Kernel.prototype.fsWriteFile = function (parts, content) {
    const parts2 = parts.slice();
    const name = parts2.pop();
    const dir = this.fsLookup(parts2);
    if (!dir || dir.type !== 'dir') return 'la ruta padre no existe';
    const exist = dir.children.find((c) => c.name === name);
    if (exist) {
      if (exist.type !== 'file') return `'${name}' es un directorio`;
      if (exist.virtual) return `'${name}' es virtual del sistema (protegido)`;
      exist.content = content;
      return null;
    }
    dir.children.push({ type: 'file', name, content, owner: 0 });
    return null;
  };

  Kernel.prototype.fsMkdir = function (parts) {
    const parts2 = parts.slice();
    const name = parts2.pop();
    const dir = this.fsLookup(parts2);
    if (!dir || dir.type !== 'dir') return 'la ruta padre no existe';
    if (dir.children.find((c) => c.name === name)) return `'${name}' ya existe`;
    dir.children.push({ type: 'dir', name, children: [], owner: 0 });
    return null;
  };

  Kernel.prototype.fsDelete = function (parts, recursive) {
    const dir = this.fsLookup(parts.slice(0, -1));
    const name = parts[parts.length - 1];
    if (!dir || dir.type !== 'dir') return 'la ruta padre no existe';
    const idx = dir.children.findIndex((c) => c.name === name);
    if (idx === -1) return `no existe '${name}'`;
    const node = dir.children[idx];
    if (node.type === 'dir' && node.children.length && !recursive) return `'${name}' no está vacío (use rm -r)`;
    dir.children.splice(idx, 1);
    return null;
  };

  Kernel.prototype.fsMove = function (fromParts, toParts) {
    const dirFrom = this.fsLookup(fromParts.slice(0, -1));
    const name = fromParts[fromParts.length - 1];
    if (!dirFrom) return 'origen no existe';
    const idx = dirFrom.children.findIndex((c) => c.name === name);
    if (idx === -1) return `no existe '${name}'`;
    const node = dirFrom.children[idx];
    // destino: ¿directorio existente o nueva ruta?
    let destDir, destName;
    const destNode = this.fsLookup(toParts);
    if (destNode && destNode.type === 'dir') {
      destDir = destNode;
      destName = name; // renombrar dentro
    } else {
      destDir = this.fsLookup(toParts.slice(0, -1));
      destName = toParts[toParts.length - 1];
      if (!destDir || destDir.type !== 'dir') return 'destino no existe';
    }
    if (destDir.children.find((c) => c.name === destName)) return `'${destName}' ya existe en el destino`;
    dirFrom.children.splice(idx, 1);
    node.name = destName;
    destDir.children.push(node);
    return null;
  };

  // ---------------------- WALLPAPERS / FONDOS ----------------------
  // Obtener lista de wallpapers disponibles en /home/juan/fondos
  Kernel.prototype.getWallpapers = function () {
    const fondosDir = this.fsLookup(['home', 'juan', 'fondos']);
    if (!fondosDir || fondosDir.type !== 'dir') return [];
    return fondosDir.children
      .filter(c => c.type === 'file' && (c.meta?.isWallpaper || /\.(jpg|jpeg|png|webp|gif|svg)$/i.test(c.name)))
      .map(c => ({
        name: c.name,
        content: c.content,
        meta: c.meta || {},
        path: '/home/juan/fondos/' + c.name
      }));
  };

  // Guardar wallpaper desde URL (descarga y guarda como base64 en /home/juan/fondos)
  Kernel.prototype.saveWallpaperFromUrl = async function (url, fileName) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'SimSys-OS/1.0' } });
      if (!res.ok) return { error: `HTTP ${res.status}: ${res.statusText}` };
      const blob = await res.blob();
      if (blob.size > 10 * 1024 * 1024) return { error: 'Archivo > 10MB' };
      const mime = blob.type || 'image/jpeg';
      const buffer = await blob.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      const dataUrl = `data:${mime};base64,${base64}`;
      
      // Nombre único si ya existe
      const fondosDir = this.fsLookup(['home', 'juan', 'fondos']);
      if (!fondosDir) return { error: 'Carpeta fondos no existe' };
      
      let finalName = fileName || url.split('/').pop() || 'wallpaper.jpg';
      if (!/\.(jpg|jpeg|png|webp|gif|svg)$/i.test(finalName)) {
        const ext = mime.split('/')[1] || 'jpg';
        finalName += '.' + ext;
      }
      
      let counter = 1;
      const baseName = finalName.replace(/\.[^.]+$/, '');
      const ext = finalName.match(/\.([^.]+)$/)?.[1] || 'jpg';
      while (fondosDir.children.find(c => c.name === finalName)) {
        finalName = `${baseName} (${counter}).${ext}`;
        counter++;
      }
      
      const err = this.fsWriteFile(['home', 'juan', 'fondos', finalName], dataUrl);
      if (err) return { error: err };
      
      // Marcar como wallpaper
      const newFile = fondosDir.children.find(c => c.name === finalName);
      if (newFile) newFile.meta = { isWallpaper: true, sourceUrl: url, savedAt: Date.now() };
      
      return { ok: true, name: finalName, path: '/home/juan/fondos/' + finalName, dataUrl };
    } catch (e) {
      return { error: e.message };
    }
  };

  // Guardar wallpaper desde archivo local (data URL)
  Kernel.prototype.saveWallpaperFromDataUrl = function (dataUrl, fileName) {
    const fondosDir = this.fsLookup(['home', 'juan', 'fondos']);
    if (!fondosDir) return { error: 'Carpeta fondos no existe' };
    
    let finalName = fileName || 'wallpaper.jpg';
    if (!/\.(jpg|jpeg|png|webp|gif|svg)$/i.test(finalName)) finalName += '.jpg';
    
    let counter = 1;
    const baseName = finalName.replace(/\.[^.]+$/, '');
    const ext = finalName.match(/\.([^.]+)$/)?.[1] || 'jpg';
    while (fondosDir.children.find(c => c.name === finalName)) {
      finalName = `${baseName} (${counter}).${ext}`;
      counter++;
    }
    
    const err = this.fsWriteFile(['home', 'juan', 'fondos', finalName], dataUrl);
    if (err) return { error: err };
    
    const newFile = fondosDir.children.find(c => c.name === finalName);
    if (newFile) newFile.meta = { isWallpaper: true, savedAt: Date.now() };
    
    return { ok: true, name: finalName, path: '/home/juan/fondos/' + finalName, dataUrl };
  };

  // Establecer wallpaper actual (usa la data URL del archivo)
  Kernel.prototype.setWallpaperFromFile = function (fileName) {
    const fondosDir = this.fsLookup(['home', 'juan', 'fondos']);
    if (!fondosDir) return { error: 'Carpeta fondos no existe' };
    const file = fondosDir.children.find(c => c.name === fileName);
    if (!file) return { error: `No existe ${fileName}` };
    if (!file.content || !file.content.startsWith('data:')) return { error: 'No es una imagen válida' };
    return { ok: true, dataUrl: file.content, meta: file.meta };
  };


  Kernel.prototype._log = function (type, text) {
    this.log.push({ tick: this.ticks, type, text });
    if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
  };

  // --------------------------- PROCESOS -------------------------------------
  Kernel.prototype.createProcess = function (opts = {}) {
    const burst = opts.burst ?? 30 + rand(60);
    const p = {
      pid: this.nextPid++,
      name: opts.name || `proceso-${this.nextPid}`,
      icon: opts.icon || '🧩',
      kind: opts.kind || 'app',
      priority: clamp(opts.priority ?? rand(10), 0, 10), // PRIORIDAD
      quantum: clamp(opts.quantum ?? this.cfg.quantumBase, 1, 12), // QUANTUM POR PROCESO
      burstTotal: burst,
      burstLeft: burst,
      memNeed: opts.mem ?? 16 + rand(120), // MB requeridos
      memBlocks: null,
      internalFrag: 0, // fragmentación interna (MB)
      io: opts.io || [], // dispositivos preferidos
      devicesHeld: [], // {devId, instanceIdx, ioLeft, mode:'io'|'hold'}
      deviceWanted: null,
      ioTicksLeft: 0,
      blockedOn: null,
      waitedTicks: 0,
      cpuTicks: 0,
      ioCount: 0,
      producing: 20,
      starved: false,
      creationTick: this.ticks,
      endTick: null,
      exitReason: null,
      hist: [], // actividad para gráficas por proceso
    };
    this.metrics.created++;
    this.processes.push(p);
    p.state = STATES.NEW;
    this._log('create', `nuevo: ${p.name} (PID ${p.pid}) — ráfaga ${burst}, prio ${p.priority}, quantum ${p.quantum}, mem ${p.memNeed} MB`);
    this.tryAdmit(p);
    return p;
  };

  // Admisión: NEW/SUSPENDED → READY si hay memoria (particiones dinámicas)
  Kernel.prototype.tryAdmit = function (p) {
    if (p.state !== STATES.NEW && p.state !== STATES.SUSPENDED) return true;
    const need = Math.ceil(p.memNeed / this.cfg.blockSize);
    const free = this.memBlocks.reduce((a, b) => a + (b === null ? 1 : 0), 0);
    if (free < need) {
      if (this.ticks % 5 === 0)
        this._log('mem', `memoria insuficiente para PID ${p.pid} (${need} bloques libres necesarios): espera en NEW`);
      return false;
    }
    let idxs = this._findHole(need);
    if (!idxs && this.cfg.autoCompact) {
      // suficiente memoria pero dispersa → FRAGMENTACIÓN EXTERNA → compacar
      this._log('mem', `PID ${p.pid}: huecos dispersos (fragmentación EXTERNA) → COMPACTACIÓN automática`);
      this.compact();
      idxs = this._findHole(need);
    }
    if (!idxs) {
      this._log('mem', `PID ${p.pid}: asignación imposible sin compactar — active 'compactación' en Gestor de Memoria`);
      return false;
    }
    for (const i of idxs) this.memBlocks[i] = p.pid;
    p.memBlocks = idxs;
    const allocated = idxs.length * this.cfg.blockSize;
    p.internalFrag = allocated - p.memNeed; // FRAGMENTACIÓN INTERNA
    if (p.internalFrag > 0)
      this._log(
        'mem',
        `PID ${p.pid}: fragmentación INTERNA de ${p.internalFrag} MB (demanda ${p.memNeed} MB → asignado ${allocated} MB)`
      );
    p.state = STATES.READY;
    p.waitedTicks = 0;
    this.metrics.admissions++;
    this._log('admit', `admitido ${p.name} (PID ${p.pid}) → LISTO con ${idxs.length} bloques`);
    return true;
  };

  // Primero/mejor ajuste sobre huecos
  Kernel.prototype._findHole = function (need) {
    let i = 0;
    let best = null;
    while (i < this.memBlocks.length) {
      if (this.memBlocks[i] !== null) { i++; continue; }
      let j = i;
      while (j < this.memBlocks.length && this.memBlocks[j] === null) j++;
      const size = j - i;
      if (size >= need) {
        if (this.strategy === 'first') return range(i, need);
        if (!best || size < best.size) best = { i, size };
      }
      i = j;
    }
    if (this.strategy === 'best' && best) return range(best.i, need);
    return null;
  };

  // COMPACTACIÓN: reorganiza los bloques usados hacia el inicio de la memoria
  Kernel.prototype.compact = function () {
    const perPid = new Map();
    for (let i = 0; i < this.memBlocks.length; i++) {
      const pid = this.memBlocks[i];
      if (pid !== null) {
        if (!perPid.has(pid)) perPid.set(pid, []);
        perPid.get(pid).push(i);
      }
    }
    this.memBlocks.fill(null);
    let cursor = 0;
    for (const [pid, idxs] of [...perPid.entries()].sort((a, b) => a[1][0] - b[1][0])) {
      const proc = this.processes.find((p) => p.pid === pid);
      const newIdx = [];
      for (let k = 0; k < idxs.length; k++) {
        this.memBlocks[cursor] = pid;
        newIdx.push(cursor);
        cursor++;
      }
      if (proc) proc.memBlocks = newIdx;
    }
    this.metrics.compactations++;
    this._log('mem', `COMPACTACIÓN ejecutada (t=${this.ticks}) — la memoria libre quedó contigua`);
  };

  Kernel.prototype._freeMem = function (p) {
    if (!p.memBlocks) return;
    for (const i of p.memBlocks) this.memBlocks[i] = null;
    p.memBlocks = null;
  };

  Kernel.prototype.setStrategy = function (s) {
    if (s === 'first' || s === 'best') this.strategy = s;
  };

  // ---------------------- SEMÁFOROS (sincronización) ------------------------
  Kernel.prototype.semWait = function (semId, pid) {
    const s = this.semaphores[semId];
    this.metrics.semWaitOps++;
    if (s.value > 0) { s.value--; return true; }
    s.waiting.push(pid);
    const p = this.processes.find((x) => x.pid === pid);
    if (p && p.state === STATES.RUNNING) {
      p.state = STATES.BLOCKED;
      p.blockedOn = 'sem:' + semId;
      p.deviceWanted = null;
      this._log('sync', `PID ${pid} se BLOQUEA en semáforo '${semId}' (espera de sincronización)`);
    }
    return false;
  };

  Kernel.prototype.semSignal = function (semId) {
    const s = this.semaphores[semId];
    this.metrics.semSignalOps++;
    const pid = s.waiting.shift();
    if (pid !== undefined) {
      const p = this.processes.find((x) => x.pid === pid);
      if (p && p.state === STATES.BLOCKED) {
        p.state = STATES.READY;
        p.blockedOn = null;
        p.waitedTicks = 0;
        this._log('sync', `semSignal('${semId}') desbloquea a PID ${pid} → LISTO`);
      }
    } else s.value++;
  };

  // -------------------------- E/S y dispositivos ----------------------------
  Kernel.prototype._device = function (id) {
    return this.devices.find((d) => d.id === id);
  };

  // Petición de dispositivo:
  //  - modo 'io'  → proceso se BLOQUEA haciendo E/S
  //  - modo 'hold' → el proceso CONSERVA el dispositivo mientras sigue
  //    ejecutándose (trabajo continuo/exclusivo)… y puede luego pedir otro:
  //    he aquí el escenario real de mantener-y-esperar del INTERBLOQUEO.
  Kernel.prototype._requestDevice = function (p, devId, mode = 'io') {
    const d = this._device(devId);
    if (!d) return false;
    // no pedir lo que ya se posee (evita esperas consigo mismo)
    if (p.devicesHeld.some((x) => x.devId === devId)) return false;
    const freeIdx = d.allocated.indexOf(null);
    if (freeIdx !== -1) {
      d.allocated[freeIdx] = p.pid;
      p.devicesHeld.push({ devId, instanceIdx: freeIdx, ioLeft: mode === 'io' ? 4 + rand(18) : 8 + rand(20), mode });
      p.ioCount++;
      if (mode === 'io') {
        p.state = STATES.BLOCKED;
        p.blockedOn = 'io:' + devId;
        p.deviceWanted = null;
        if (devId === 'disk') this._diskWrite(p);
        this._log('io', `PID ${p.pid} obtiene ${d.name} → BLOQUEADO por E/S`);
      } else {
        this._log('io', `PID ${p.pid} mantiene ${d.name} en uso exclusivo mientras sigue en CPU`);
      }
      return true;
    }
    // mantener-y-esperar: conserva sus recursos y espera este dispositivo
    p.state = STATES.BLOCKED;
    p.blockedOn = 'dev:' + devId;
    p.deviceWanted = devId;
    d.queue.push(p.pid);
    this._log('wait', `PID ${p.pid} ESPERA ${d.name} (instancias ocupadas) — mantener-y-esperar`);
    return false;
  };

  // Elige del grupo un dispositivo que el proceso aún no posea
  Kernel.prototype._requestDeviceRandom = function (p, pool, mode) {
    const candidates = pool.filter((id) => !p.devicesHeld.some((x) => x.devId === id));
    if (!candidates.length || p.devicesHeld.length >= 2) return;
    this._requestDevice(p, candidates[rand(candidates.length)], mode);
  };

  // Otorga instancias libres a procesos bloqueados en 'dev:xxx'
  Kernel.prototype._retryDeviceWaits = function () {
    for (const p of this.processes) {
      if (!(p.state === STATES.BLOCKED && p.blockedOn && p.blockedOn.startsWith('dev:'))) continue;
      const d = this._device(p.deviceWanted);
      if (!d) { p.blockedOn = null; p.deviceWanted = null; p.state = STATES.READY; continue; }
      const freeIdx = d.allocated.indexOf(null);
      if (freeIdx === -1) continue;
      d.queue = d.queue.filter((x) => x !== p.pid);
      d.allocated[freeIdx] = p.pid;
      p.devicesHeld.push({ devId: d.id, instanceIdx: freeIdx, ioLeft: 6 + rand(16), mode: 'io' });
      p.ioCount++;
      p.state = STATES.BLOCKED;
      p.blockedOn = 'io:' + d.id;
      p.deviceWanted = null;
      if (d.id === 'disk') this._diskWrite(p);
      this._log('io', `PID ${p.pid} consigue ${d.name} tras espera → E/S`);
    }
  };

  Kernel.prototype._releaseDeviceInstance = function (devId, idx) {
    const d = this._device(devId);
    if (!d) return;
    d.allocated[idx] = null;
    while (d.queue.length) {
      const pid = d.queue.shift();
      const p = this.processes.find((x) => x.pid === pid);
      if (p && p.state === STATES.BLOCKED && p.deviceWanted === devId) {
        d.allocated[idx] = pid;
        p.devicesHeld.push({ devId, instanceIdx: idx, ioLeft: 6 + rand(16), mode: 'io' });
        p.ioCount++;
        p.deviceWanted = null;
        p.blockedOn = 'io:' + devId;
        if (devId === 'disk') this._diskWrite(p);
        this._log('io', `${d.name} reasignada a PID ${pid} (salía de la cola de espera)`);
        return;
      }
      // el pid de la cola ya no espera ese dispositivo: continuar
    }
  };

  Kernel.prototype._releaseAllDevices = function (p) {
    for (const h of p.devicesHeld) this._releaseDeviceInstance(h.devId, h.instanceIdx);
    p.devicesHeld = [];
  };

  Kernel.prototype._diskWrite = function (p) {
    const mb = 1 + rand(24);
    this.disk.usedMB = Math.min(this.disk.totalMB, this.disk.usedMB + mb);
    this.disk.files.push({
      name: `${p.kind}-p${p.pid}-${this.ticks}.bin`,
      owner: p.pid,
      ownerName: p.name,
      sizeMB: mb,
      creationTick: this.ticks,
    });
    if (this.disk.files.length > 80) {
      const removed = this.disk.files.splice(0, this.disk.files.length - 80);
      for (const f of removed) this.disk.usedMB = Math.max(12 * 1024, this.disk.usedMB - f.sizeMB);
    }
  };

  // -------------------- DETECCIÓN DE INTERBLOQUEO ---------------------------
  // Grafo de asignación de recursos: proceso →(espera)→ dispositivo,
  // dispositivo →(asignado a)→ proceso. Un ciclo = INTERBLOQUEO.
  Kernel.prototype._detectDeadlock = function () {
    const blocked = this.processes.filter((p) => p.state === STATES.BLOCKED && p.blockedOn && p.blockedOn.startsWith('dev:'));
    if (!blocked.length) {
      if (this.deadlock.active) {
        this.deadlock = { active: false, cycle: [], resolvedWith: null };
        this._log('sync', 'el estado de interbloqueo fue despejado');
      }
      return;
    }
    const holders = new Map(); // devId -> [pid que posee instancias]
    for (const d of this.devices) {
      const hs = d.allocated.filter((x) => x !== null);
      if (hs.length) holders.set(d.id, hs);
    }
    const waitGraph = new Map(); // pid -> Set(pids que poseen lo que espera)
    for (const p of blocked) {
      const devId = p.blockedOn.slice(4);
      const targets = (holders.get(devId) || []).filter((t) => t !== p.pid);
      if (!targets.length) continue;
      if (!waitGraph.has(p.pid)) waitGraph.set(p.pid, new Set());
      for (const t of targets) waitGraph.get(p.pid).add(t);
    }
    const cycle = findCycle(waitGraph);
    if (cycle.length) {
      if (!this.deadlock.active) {
        this.deadlock = { active: true, cycle: cycle.slice().sort((a, b) => a - b), resolvedWith: null };
        this.metrics.deadlocksDetected++;
        const names = this.deadlock.cycle.map((pid) => `PID ${pid}`).join(' ⇄ ');
        this._log('DEADLOCK', `⚠ ¡INTERBLOQUEO detectado entre ${names}! Espera circular de recursos.`);
      } else {
        this.deadlock.cycle = cycle.slice().sort((a, b) => a - b);
      }
      if (this.cfg.autoResolveDeadlock) this.resolveDeadlock(null);
    } else if (this.deadlock.active) {
      this.deadlock = { active: false, cycle: [], resolvedWith: null };
    }
  };

  // DFS para buscar un ciclo en el grafo de espera
  function findCycle(graph) {
    const color = new Map(); // 0 blanco, 1 gris, 2 negro
    for (const n of graph.keys()) color.set(n, 0);
    const dfs = (n, path) => {
      color.set(n, 1);
      path.push(n);
      for (const t of graph.get(n) || []) {
        const c = color.get(t) ?? 0;
        if (c === 1) return path.slice(path.indexOf(t));
        if (c === 0) {
          const r = dfs(t, path);
          if (r) return r;
        }
      }
      color.set(n, 2);
      path.pop();
      return null;
    };
    for (const n of graph.keys()) {
      if ((color.get(n) ?? 0) === 0) {
        const r = dfs(n, []);
        if (r) return r;
      }
    }
    return [];
  }

  // Resolver interbloqueo abortando una víctima y liberando sus recursos
  Kernel.prototype.resolveDeadlock = function (victimPid) {
    if (!this.deadlock.active) return;
    let victim = victimPid != null ? this.processes.find((p) => p.pid === victimPid) : null;
    if (!victim) {
      const cands = this.processes.filter((p) => this.deadlock.cycle.includes(p.pid));
      victim = cands.sort((a, b) => a.priority - b.priority)[0];
    }
    if (!victim) return;
    this._log('DEADLOCK', `resolución: se aborta a la víctima ${victim.name} (PID ${victim.pid}) y se liberan sus recursos`);
    this._releaseAllDevices(victim);
    this._freeMem(victim);
    victim.state = STATES.TERMINATED;
    victim.endTick = this.ticks;
    victim.exitReason = 'Víctima del interbloqueo (abortado)';
    victim.burstLeft = 0;
    this.metrics.deadlocksResolved++;
    this.metrics.terminated++;
    this.deadlock.resolvedWith = victim.pid;
    this.deadlock.active = false;
    this.deadlock.cycle = [];
    for (const p of this.processes) if (p.state === STATES.NEW) this.tryAdmit(p);
  };

  // --------------------- TERMINACIÓN Y CONTROL ------------------------------
  Kernel.prototype.kill = function (pid, reason = 'finalizado por el usuario') {
    const p = this.processes.find((x) => x.pid === pid);
    if (!p || p.state === STATES.TERMINATED) return false;
    this._releaseAllDevices(p);
    this._freeMem(p);
    p.state = STATES.TERMINATED;
    p.endTick = this.ticks;
    p.exitReason = reason;
    p.burstLeft = 0;
    this.metrics.terminated++;
    this._log('kill', `PID ${pid} (${p.name}) ${reason}`);
    for (const core of this.cores) if (core.pid === pid) core.pid = null;
    return true;
  };

  Kernel.prototype.setPriority = function (pid, prio) {
    const p = this.processes.find((x) => x.pid === pid);
    if (!p) return;
    p.priority = clamp(prio, 0, 10);
    this._log('sched', `PID ${pid}: nueva prioridad ${p.priority}`);
  };

  Kernel.prototype.setQuantum = function (pid, q) {
    const p = this.processes.find((x) => x.pid === pid);
    if (!p) return;
    p.quantum = clamp(q, 1, 12);
    if (p.quantumLeft === undefined || p.quantumLeft > p.quantum) p.quantumLeft = p.quantum;
    this._log('sched', `PID ${pid}: quantum ${p.quantum} ticks`);
  };

  Kernel.prototype.suspend = function (pid) {
    const p = this.processes.find((x) => x.pid === pid);
    if (!p || (p.state !== STATES.READY && p.state !== STATES.RUNNING)) return;
    p.state = STATES.SUSPENDED;
    for (const c of this.cores) if (c.pid === pid) c.pid = null;
    this._log('sched', `PID ${pid} SUSPENDIDO → swap (libera CPU, conserva su memoria)`);
  };

  Kernel.prototype.resume = function (pid) {
    const p = this.processes.find((x) => x.pid === pid);
    if (!p || p.state !== STATES.SUSPENDED) return;
    p.state = STATES.NEW;
    p.blockedOn = null;
    this._log('sched', `PID ${pid} reanudado desde swap`);
    this.tryAdmit(p);
  };

  // ---------------------------- TICK ---------------------------------------
  Kernel.prototype.tick = function () {
    this.ticks++;

    if (this.ticks % 8 === 0) this._detectDeadlock();
    if (this.deadlock.active && this.cfg.autoResolveDeadlock) this.resolveDeadlock(null);

    // --- completar E/S en curso ---
    for (const p of this.processes) {
      if (p.state === STATES.BLOCKED && p.blockedOn && p.blockedOn.startsWith('io:')) {
        const h = p.devicesHeld.find((x) => x.devId === p.blockedOn.slice(3) && x.mode === 'io');
        if (!h) { p.blockedOn = null; p.state = STATES.READY; continue; }
        h.ioLeft--;
        if (h.ioLeft <= 0) {
          const devId = h.devId;
          const dev = this._device(devId);
          this._log('io', `PID ${p.pid} terminó E/S en ${dev ? dev.name : devId} → LISTO`);
          this._releaseDeviceInstance(devId, h.instanceIdx);
          p.devicesHeld = p.devicesHeld.filter((x) => x !== h);
          p.blockedOn = null;
          p.deviceWanted = null;
          p.state = STATES.READY;
          p.waitedTicks = 0;
        }
      } else if (p.state === STATES.BLOCKED && p.blockedOn && p.blockedOn.startsWith('sem:')) {
        // si no quedan actores del modelo productor/consumidor, cerrar la espera
        const hasProducers = this.processes.some((x) => x.kind === 'producer' && x.state !== STATES.TERMINATED);
        const hasConsumers = this.processes.some((x) => x.kind === 'consumer' && x.state !== STATES.TERMINATED);
        if ((p.kind === 'consumer' && !hasProducers) || (p.kind === 'producer' && !hasConsumers)) {
          this.kill(p.pid, 'finalizado — no queda con quién sincronizarse');
        } else if (++p.ioTicksLeft > 300) {
          this.kill(p.pid, 'desistido — espera de semáforo demasiado prolongada');
        }
      }
      // estable: espera en semáforo se resuelve vía semSignal
    }

    // --- dispositivos mantenidos por procesos en EJECUCIÓN (modo 'hold') ---
    for (const p of this.processes) {
      if (p.state !== STATES.RUNNING || !p.devicesHeld.length) continue;
      for (const h of [...p.devicesHeld]) {
        if (h.mode !== 'hold') continue;
        h.ioLeft--;
        if (h.ioLeft <= 0) {
          const dev = this._device(h.devId);
          this._releaseDeviceInstance(h.devId, h.instanceIdx);
          p.devicesHeld = p.devicesHeld.filter((x) => x !== h);
          this._log('io', `PID ${p.pid} libera ${dev ? dev.name : h.devId} (fin de uso exclusivo)`);
        }
      }
    }

    // --- reintentar esperas de dispositivos con instancia libre ---
    this._retryDeviceWaits();

    // --- reintentar admisión de procesos en NEW ---
    if (this.ticks % 4 === 0) {
      for (const p of this.processes) {
        if (p.state === STATES.NEW) this.tryAdmit(p);
      }
    }

    // --- planificación por núcleo ---
    for (const core of this.cores) {
      let p = core.pid !== null ? this.processes.find((x) => x.pid === core.pid && x.state === STATES.RUNNING) : null;
      if (!p) {
        const next = this._pickNext();
        if (next) {
          if (core.pid !== next.pid) this.metrics.contextSwitches++;
          core.pid = next.pid;
          next.state = STATES.RUNNING;
          next.waitedTicks = 0;
          if (next.starved) {
            this._log('starve', `PID ${next.pid} (${next.name}) ATENDIDO tras inanición — envejecimiento funcionó`);
            next.starved = false;
          }
          this._log('dispatch', `${next.name} (PID ${next.pid}) → EJECUCIÓN en CPU#${core.idx}`);
        } else {
          core.pid = null;
          continue;
        }
      }
      p = core.pid !== null ? this.processes.find((x) => x.pid === core.pid && x.state === STATES.RUNNING) : null;
      if (!p) continue;

      // ejecuta 1 instrucción
      p.cpuTicks++;
      p.burstLeft--;
      p.quantumLeft = p.quantumLeft === undefined ? p.quantum : p.quantumLeft - 1;
      this.history.ganttPts.push({ pid: p.pid, core: core.idx, tick: this.ticks });
      if (this.history.ganttPts.length > 800) this.history.ganttPts.splice(0, this.history.ganttPts.length - 800);

      // procesos productor / consumidor usan semáforos
      if (p.kind === 'producer') this._stepProducer(p);
      if (p.kind === 'consumer') this._stepConsumer(p);

      if (p.burstLeft <= 0) {
        this.kill(p.pid, 'finalizado — ráfaga de CPU completa');
        continue;
      }
      if (p.state !== STATES.RUNNING) continue; // se bloqueó en este paso

      if (p.quantumLeft <= 0) {
        // QUANTUM agotado → desalojo (alternancia de procesos)
        this.metrics.contextSwitches++;
        this._log('sched', `quantum (${p.quantum}) agotado para PID ${p.pid}: DESALOJO → LISTO`);
        p.state = STATES.READY;
        p.waitedTicks = 0;
        p.quantumLeft = p.quantum;
        core.pid = null;
        continue;
      }

      // eventos de E/S o petición de recursos adicionales
      if (Math.random() < this.cfg.ioChance) {
        const pool = p.io && p.io.length ? p.io : this.devices.map((d) => d.id);
        this._requestDeviceRandom(p, pool, 'io');
      } else if (Math.random() < this.cfg.resChance && p.kind !== 'producer' && p.kind !== 'consumer') {
        const ids = this.devices.map((d) => d.id);
        this._requestDeviceRandom(p, ids, 'hold');
      }
    }

    // --- envejecimiento / evidencia de INANICIÓN ---
    for (const p of this.processes) {
      if (p.state === STATES.READY) {
        p.waitedTicks++;
        if (p.waitedTicks > this.cfg.starvationThreshold && !p.starved) {
          p.starved = true;
          this.metrics.starved++;
          this._log('starve', `⚠ INANICIÓN: PID ${p.pid} (${p.name}) lleva ${p.waitedTicks} ticks en LISTO sin CPU — prioridad baja desatendida`);
        }
        if (p.waitedTicks > 0 && p.waitedTicks % 30 === 0 && p.priority < 10 && p.waitedTicks >= 30) {
          p.priority++; // envejecimiento
          p.waitedTicks = 0;
          this._log('sched', `envejecimiento (aging): prioridad de PID ${p.pid} sube a ${p.priority} por espera prolongada`);
        }
      }
      p.hist.push({ t: this.ticks, s: p.state === STATES.RUNNING ? 1 : 0 });
      if (p.hist.length > 160) p.hist.shift();
    }

    this._sample();
  };

  // Elección del siguiente proceso: mayor prioridad primero (FCFS como desempate)
  Kernel.prototype._pickNext = function () {
    const cand = this.processes.filter((p) => p.state === STATES.READY);
    if (!cand.length) return null;
    cand.sort((a, b) => b.priority - a.priority || a.pid - b.pid);
    const top = cand[0];
    const tie = cand.filter((p) => p.priority === top.priority);
    if (tie.length > 1 && Math.random() < 0.25) return tie[rand(tie.length)];
    return top;
  };

  // -------- pasos productor / consumidor (sincronización por semáforos) --------
  Kernel.prototype._stepProducer = function (p) {
    if (p.producing <= 0) return;
    if (!this.semWait('empty', p.pid)) return;
    if (!this.semWait('mutex', p.pid)) { this.semSignal('empty'); return; }
    const slot = this.buffer.indexOf(null);
    if (slot !== -1) {
      this.buffer[slot] = { from: p.pid, item: `dato-${p.pid}-${rand(999)}` };
      p.producing--;
      this._log('sync', `productor PID ${p.pid} escribe buffer[${slot}] (falta producir ${p.producing})`);
    }
    this.semSignal('mutex');
    this.semSignal('full');
  };

  Kernel.prototype._stepConsumer = function (p) {
    if (!this.semWait('full', p.pid)) return;
    if (!this.semWait('mutex', p.pid)) { this.semSignal('full'); return; }
    const slot = this.buffer.findIndex((x) => x !== null);
    if (slot !== -1) {
      const item = this.buffer[slot];
      this.buffer[slot] = null;
      this._log('sync', `consumidor PID ${p.pid} consume ${item.item} de buffer[${slot}]`);
    }
    this.semSignal('mutex');
    this.semSignal('empty');
  };

  // ------------------------- muestreo para gráficas -------------------------
  Kernel.prototype._sample = function () {
    let load = 0;
    for (const c of this.cores) {
      const p = c.pid !== null ? this.processes.find((x) => x.pid === c.pid) : null;
      if (p && p.state === STATES.RUNNING) load += 100 / this.cores.length;
    }
    const usedBlocks = this.memBlocks.reduce((a, b) => a + (b !== null ? 1 : 0), 0);
    const ioBusy = this.devices.filter((d) => d.allocated.some((x) => x !== null)).length;
    this.history.cpu.push({ t: this.ticks, v: load });
    this.history.mem.push({ t: this.ticks, v: (usedBlocks / this.memBlocks.length) * 100 });
    this.history.io.push({ t: this.ticks, v: (ioBusy / this.devices.length) * 100 });
    for (const k of ['cpu', 'mem', 'io']) if (this.history[k].length > 240) this.history[k].shift();
  };

  // ------------------------- métricas derivadas -----------------------------
  Kernel.prototype.memStats = function () {
    const blocks = this.memBlocks;
    const used = blocks.reduce((a, b) => a + (b !== null ? 1 : 0), 0);
    const free = blocks.length - used;
    let holes = 0;
    let holeBytes = 0;
    let i = 0;
    while (i < blocks.length) {
      if (blocks[i] === null) {
        let j = i;
        while (j < blocks.length && blocks[j] === null) j++;
        holes++;
        holeBytes += (j - i) * this.cfg.blockSize;
        i = j;
      } else i++;
    }
    const internalFrag = this.processes.reduce((a, p) => a + (p.memBlocks ? p.internalFrag : 0), 0);
    return {
      totalMB: blocks.length * this.cfg.blockSize,
      usedMB: used * this.cfg.blockSize,
      freeMB: free * this.cfg.blockSize,
      holes,
      holeBytes,
      internalFragMB: internalFrag,
      fragExternaPct: used + free > 0 ? (holeBytes / blocks.length / this.cfg.blockSize) * 100 : 0,
      usedPct: (used / blocks.length) * 100,
      procesosResidentes: new Set(blocks.filter((b) => b !== null)).size,
      comprimiblePct: free > 0 ? (holeBytes / (free * this.cfg.blockSize)) * 100 : 0,
    };
  };

  Kernel.prototype.stateCounts = function () {
    const c = { new: 0, ready: 0, running: 0, blocked: 0, suspended: 0, terminated: 0 };
    for (const p of this.processes) c[p.state] = (c[p.state] || 0) + 1;
    return c;
  };

  Kernel.prototype.cpuLoad = function () {
    let v = 0;
    for (const c of this.cores) {
      const p = c.pid !== null ? this.processes.find((x) => x.pid === c.pid) : null;
      if (p && p.state === STATES.RUNNING) v += 100 / this.cores.length;
    }
    return v;
  };

  // ---------------------------- arranque ------------------------------------
  Kernel.prototype.boot = function () {
    this._log('boot', 'Iniciando núcleo SimSys…');
    this._log('boot', `planificador: Round-Robin por prioridades • quantum base ${this.cfg.quantumBase} • ${this.cfg.cores} núcleos`);
    this._log('boot', `memoria: ${this.cfg.memTotal} MB en bloques de ${this.cfg.blockSize} MB (particiones dinámicas + compactación)`);
    for (const d of this.devices) this._log('boot', `dispositivo: ${d.name} — ${d.instances} instancia(s)`);
    for (const def of INITIAL_PROCESSES) this.createProcess(def);
    this._log('boot', `sistema en marcha con ${INITIAL_PROCESSES.length} procesos iniciales`);
  };

  return Kernel;
});
