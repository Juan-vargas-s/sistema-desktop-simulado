// ============================================================
// SimSys OS — Proceso principal (main) de Electron
// - Crea la ventana del escritorio simulado
// - Expone estadísticas REALES del hardware (CPU, RAM, Disco)
// - Configuración idéntica a "Sistema Móvil": nodeIntegration ON,
//   contextIsolation OFF y webviewTag ON para que los navegadores
//   internos (Telegram/WhatsApp/Navegador) rendericen a tamaño real.
// ============================================================
const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const os = require('os');
const fs = require('fs');
const path = require('path');

let mainWindow = null;

// ---------------- Estadísticas reales del equipo ----------------
let prevCpuTimes = null;

function sampleCpuTimes() {
  const cores = os.cpus().map((c) => {
    const t = c.times;
    return { busy: t.user + t.nice + t.sys + t.irq, idle: t.idle };
  });
  return cores;
}

if (prevCpuTimes === null) prevCpuTimes = sampleCpuTimes();

function getHardwareInfo() {
  const nowCpu = sampleCpuTimes();
  let cpuUsage = [];
  try {
    cpuUsage = nowCpu.map((c, i) => {
      const p = prevCpuTimes[i] || { busy: c.busy, idle: c.idle };
      const dBusy = c.busy - p.busy;
      const dIdle = c.idle - p.idle;
      const total = dBusy + dIdle;
      return total > 0 ? Math.min(100, Math.max(0, (dBusy / total) * 100)) : 0;
    });
  } catch (_) {}
  prevCpuTimes = nowCpu;

  // Disco real
  let disk = { total: 0, free: 0, used: 0, mount: os.platform() === 'win32' ? 'C:' : '/' };
  try {
    const st = fs.statfsSync(disk.mount);
    const bsize = st.bsize || 4096;
    disk.total = (st.blocks * bsize) / 2 ** 30; // GB
    disk.free = (st.bavail * bsize) / 2 ** 30;
    disk.used = disk.total - disk.free;
  } catch (_) {}

  return {
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    hostname: os.hostname(),
    uptimeHost: os.uptime(),
    cpu: {
      model: os.cpus()[0]?.model || 'Desconocido',
      cores: os.cpus().length,
      speedMHz: os.cpus()[0]?.speed || 0,
      usage: cpuUsage,
    },
    mem: {
      total: os.totalmem() / 2 ** 30, // GB
      free: os.freemem() / 2 ** 30,
      used: (os.totalmem() - os.freemem()) / 2 ** 30,
    },
    disk,
    loadavg: os.loadavg(),
  };
}

// ---------------- Ventana de aplicación WEB (mensajería) ----------------
const webApps = new Map();

function openWebApp(name, url) {
  const existing = webApps.get(name);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return true;
  }
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 700,
    minHeight: 480,
    title: name,
    autoHideMenuBar: true,
    icon: undefined,
    webPreferences: {
      partition: 'persist:webapps',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  Menu.setApplicationMenu(null);
  webApps.set(name, win);
  win.on('closed', () => webApps.delete(name));

  // Abrir enlaces externos en una nueva ventana hijas de la misma sesión
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { partition: 'persist:webapps' } } };
  });

  win.loadURL(url).catch(() => {});
  return true;
}

// ---------------- IPC ----------------
ipcMain.handle('hardware:info', () => getHardwareInfo());
ipcMain.handle('webapp:open', (_e, name, url) => openWebApp(name, url));
ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
}));

// ---------------- Ventana principal ----------------
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    title: 'SimSys OS — Simulador de Sistema Operativo',
    autoHideMenuBar: true,
    backgroundColor: '#05070f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // RECETA del proyecto "Sistema Móvil" (renderiza <webview> a tamaño real):
      // nodeIntegration:true + contextIsolation:false + webviewTag:true
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false,
      webviewTag: true, // permite integrar navegadores web en ventanas del escritorio
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().filter((w) => w !== mainWindow).length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
