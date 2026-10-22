// ============================================================
// SimSys OS — preload: puente seguro entre el proceso principal
// de Electron y la interfaz (escritorio simulado).
// ============================================================
const { contextBridge, ipcRenderer } = require('electron');

const osAPI = {
  // Estadísticas reales de la máquina anfitriona
  getHardware: () => ipcRenderer.invoke('hardware:info'),
  // Abrir una app web (Telegram Web, WhatsApp Web, etc.)
  openWebApp: (name, url) => ipcRenderer.invoke('webapp:open', name, url),
  // Información del entorno
  getAppInfo: () => ipcRenderer.invoke('app:info'),
};

// Con contextIsolation:false (receta "Sistema Móvil") el bridge no es
// necesario: se asigna directo. Con isolation activa usamos contextBridge.
if (process.contextIsolated) contextBridge.exposeInMainWorld('osAPI', osAPI);
else window.osAPI = osAPI;
