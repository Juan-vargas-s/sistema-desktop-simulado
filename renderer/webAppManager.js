// =============================================
// WEB APP MANAGER — Empaquetado de aplicaciones web (Desktop)
// Permite instalar, gestionar y ejecutar web apps como apps nativas
// =============================================

const WebAppManager = {
  // Almacenamiento de web apps instaladas
  installedApps: new Map(),
  manifests: new Map(),

  // Inicializar el gestor
  init() {
    this.loadInstalledApps();
    console.log('[WebAppManager] Inicializado');
  },

  // Cargar apps instaladas desde localStorage
  loadInstalledApps() {
    try {
      const stored = localStorage.getItem('webapp_installed');
      if (stored) {
        const apps = JSON.parse(stored);
        for (const [id, app] of Object.entries(apps)) {
          this.installedApps.set(id, app);
          this.registerInAppsList(id, app);
        }
      }
      const manifests = localStorage.getItem('webapp_manifests');
      if (manifests) {
        const parsed = JSON.parse(manifests);
        for (const [id, manifest] of Object.entries(parsed)) {
          this.manifests.set(id, manifest);
        }
      }
    } catch (e) {
      console.error('[WebAppManager] Error cargando apps:', e);
    }
  },

  // Guardar apps instaladas
  saveInstalledApps() {
    try {
      const apps = Object.fromEntries(this.installedApps);
      localStorage.setItem('webapp_installed', JSON.stringify(apps));
      const manifests = Object.fromEntries(this.manifests);
      localStorage.setItem('webapp_manifests', JSON.stringify(manifests));
    } catch (e) {
      console.error('[WebAppManager] Error guardando apps:', e);
    }
  },

  // Registrar una web app en el array Apps global
  registerInAppsList(appId, app) {
    // Verificar si ya existe
    const existing = Apps.find(a => a.name === app.name || (a.webAppId && a.webAppId === appId));
    if (existing) return;

    const webApp = {
      name: app.name,
      icon: app.icon || '🌐',
      w: 1080,
      h: 720,
      isWebApp: true,
      webAppId: appId,
      launch: (body, win) => this.renderWebApp(body, win, appId)
    };

    Apps.push(webApp);
    
    // Reconstruir menús si ya están inicializados
    if (typeof buildMenus === 'function') {
      buildMenus();
    }
  },

  // Desregistrar del array Apps
  unregisterFromAppsList(appId) {
    const index = Apps.findIndex(a => a.webAppId === appId);
    if (index !== -1) {
      Apps.splice(index, 1);
      if (typeof buildMenus === 'function') {
        buildMenus();
      }
    }
  },

  // Instalar una web app desde URL
  async installFromUrl(url, options = {}) {
    try {
      if (url.endsWith('.json') || url.includes('manifest')) {
        return await this.installFromManifest(url);
      }

      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (SimSys OS) WebAppInstaller/1.0' }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      const manifest = this.extractManifestFromHtml(html, url);
      Object.assign(manifest, options);

      return await this.install(manifest);
    } catch (error) {
      console.error('[WebAppManager] Error instalando desde URL:', error);
      throw error;
    }
  },

  // Instalar desde un manifiesto Web App Manifest (W3C)
  async installFromManifest(manifestUrl) {
    try {
      const response = await fetch(manifestUrl);
      if (!response.ok) throw new Error(`No se pudo cargar el manifiesto: ${response.status}`);

      const manifest = await response.json();
      const normalized = this.normalizeManifest(manifest, manifestUrl);
      return await this.install(normalized);
    } catch (error) {
      console.error('[WebAppManager] Error instalando desde manifiesto:', error);
      throw error;
    }
  },

  // Normalizar manifiesto W3C
  normalizeManifest(manifest, sourceUrl) {
    const baseUrl = new URL(sourceUrl).origin;

    return {
      id: this.generateAppId(manifest.name || manifest.short_name || 'webapp'),
      name: manifest.name || manifest.short_name || 'Web App',
      shortName: manifest.short_name || manifest.name || 'WebApp',
      description: manifest.description || '',
      startUrl: manifest.start_url ? new URL(manifest.start_url, baseUrl).href : baseUrl,
      scope: manifest.scope ? new URL(manifest.scope, baseUrl).href : baseUrl,
      display: manifest.display || 'standalone',
      orientation: manifest.orientation || 'portrait-primary',
      themeColor: manifest.theme_color || '#0078d7',
      backgroundColor: manifest.background_color || '#0a0f1e',
      icons: manifest.icons || [],
      icon: this.selectBestIcon(manifest.icons) || '🌐',
      categories: manifest.categories || ['web'],
      screenshots: manifest.screenshots || [],
      shortcuts: manifest.shortcuts || [],
      preferRelatedApplications: manifest.prefer_related_applications || false,
      relatedApplications: manifest.related_applications || [],
      sourceUrl: sourceUrl,
      installedAt: Date.now(),
      updatedAt: Date.now()
    };
  },

  // Extraer manifiesto básico desde HTML
  extractManifestFromHtml(html, url) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const manifestLink = doc.querySelector('link[rel="manifest"]');
    let manifestUrl = null;
    if (manifestLink) {
      manifestUrl = new URL(manifestLink.href, url).href;
    }

    const title = doc.querySelector('title')?.textContent || 'Web App';
    const description = doc.querySelector('meta[name="description"]')?.getAttribute('content') || '';
    const themeColor = doc.querySelector('meta[name="theme-color"]')?.getAttribute('content') || '#0078d7';
    const bgColor = doc.querySelector('meta[name="background-color"]')?.getAttribute('content') || '#0a0f1e';

    const iconLink = doc.querySelector('link[rel="icon"], link[rel="apple-touch-icon"], link[rel="shortcut icon"]');
    let icon = '🌐';
    if (iconLink) {
      icon = new URL(iconLink.href, url).href;
    }

    const appleIcon = doc.querySelector('link[rel="apple-touch-icon"]');
    if (appleIcon) {
      icon = new URL(appleIcon.href, url).href;
    }

    return {
      id: this.generateAppId(title),
      name: title,
      shortName: title.length > 12 ? title.substring(0, 12) + '…' : title,
      description,
      startUrl: url,
      scope: url,
      display: 'standalone',
      orientation: 'portrait-primary',
      themeColor,
      backgroundColor: bgColor,
      icon,
      icons: iconLink ? [{ src: icon, sizes: 'any', type: 'image/*' }] : [],
      categories: ['web'],
      sourceUrl: manifestUrl || url,
      installedAt: Date.now(),
      updatedAt: Date.now(),
      isAutoExtracted: true
    };
  },

  // Seleccionar el mejor icono del manifiesto
  selectBestIcon(icons) {
    if (!icons || !icons.length) return null;
    const sorted = [...icons].sort((a, b) => {
      const sizeA = parseInt(a.sizes) || 0;
      const sizeB = parseInt(b.sizes) || 0;
      return sizeB - sizeA;
    });
    return sorted[0]?.src || null;
  },

  // Generar ID único para la app
  generateAppId(name) {
    const base = name.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 30);
    return `webapp-${base}-${Date.now().toString(36)}`;
  },

  // Instalar la app (guardar y registrar)
  async install(appData) {
    const appId = appData.id;

    if (this.installedApps.has(appId)) {
      return await this.update(appId, appData);
    }

    if (!appData.startUrl) {
      throw new Error('URL de inicio requerida');
    }

    // Descargar y cachear iconos si son URLs externas
    if (appData.icon && appData.icon.startsWith('http')) {
      try {
        appData.icon = await this.cacheIcon(appData.icon, appId);
      } catch (e) {
        console.warn('[WebAppManager] No se pudo cachear icono:', e);
        appData.icon = '🌐';
      }
    }

    this.installedApps.set(appId, appData);
    this.manifests.set(appId, appData);
    this.saveInstalledApps();
    this.registerInAppsList(appId, appData);

    OS.toast(`📦 Web App instalada: "${appData.name}"`);

    return { success: true, appId, app: appData };
  },

  // Actualizar app existente
  async update(appId, newData) {
    const existing = this.installedApps.get(appId);
    if (!existing) throw new Error('App no encontrada');

    const updated = { ...existing, ...newData, updatedAt: Date.now() };
    this.installedApps.set(appId, updated);
    this.manifests.set(appId, updated);
    this.saveInstalledApps();

    // Actualizar en Apps list
    const appIndex = Apps.findIndex(a => a.webAppId === appId);
    if (appIndex !== -1) {
      Apps[appIndex].name = updated.name;
      Apps[appIndex].icon = updated.icon || '🌐';
    }
    if (typeof buildMenus === 'function') buildMenus();

    OS.toast(`🔄 Web App actualizada: "${updated.name}"`);
    return { success: true, appId, app: updated };
  },

  // Desinstalar app
  uninstall(appId) {
    const app = this.installedApps.get(appId);
    if (!app) return { success: false, error: 'App no encontrada' };

    // Cerrar si está abierta
    for (const [name, win] of WM.wins) {
      if (win.appId === app.name || name === app.name) {
        win.close();
        break;
      }
    }

    this.installedApps.delete(appId);
    this.manifests.delete(appId);
    this.saveInstalledApps();
    this.unregisterFromAppsList(appId);

    OS.toast(`🗑️ Web App desinstalada: "${app.name}"`);
    return { success: true };
  },

  // Cachear icono como data URL
  async cacheIcon(iconUrl, appId) {
    try {
      const response = await fetch(iconUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const blob = await response.blob();
      const mime = blob.type || 'image/png';
      const buffer = await blob.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));

      return `data:${mime};base64,${base64}`;
    } catch (e) {
      console.error('[WebAppManager] Error cacheando icono:', e);
      throw e;
    }
  },

  // Renderizar web app en ventana
  renderWebApp(body, win, appId) {
    const app = this.installedApps.get(appId);
    if (!app) {
      body.innerHTML = '<div style="padding:20px;color:var(--muted)">App no encontrada</div>';
      return;
    }

    // Usar el mismo mountWebview que las otras web apps
    const initialUrl = app.startUrl;
    const webviewData = mountWebview(body, win, initialUrl);
    if (webviewData && webviewData.wv) {
      // Guardar referencia para menú contextual
      win.webview = webviewData.wv;
      win.webAppId = appId;
      win.webAppData = app;
    }
  },

  // Obtener lista de apps instaladas
  getInstalledApps() {
    return Array.from(this.installedApps.values());
  },

  // Obtener app por ID
  getApp(appId) {
    return this.installedApps.get(appId);
  },

  // Verificar si una app está instalada
  isInstalled(appId) {
    return this.installedApps.has(appId);
  },

  // Confirmar desinstalación
  confirmUninstall(appId) {
    const app = this.installedApps.get(appId);
    if (!app) return;

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);z-index:9999;display:flex;align-items:center;justify-content:center';
    overlay.innerHTML = `
      <div class="aero-card" style="max-width:340px;width:90%;padding:24px;text-align:center">
        <div style="font-size:48px;margin-bottom:16px">🗑️</div>
        <h3 style="margin-bottom:8px">Desinstalar "${app.name}"</h3>
        <p style="color:var(--muted);margin-bottom:20px;font-size:14px">Se eliminará la app y sus datos. ¿Continuar?</p>
        <div style="display:flex;gap:12px;justify-content:center">
          <button class="aero-btn aero-btn-secondary" id="cancel-uninstall">Cancelar</button>
          <button class="aero-btn aero-btn-danger" id="confirm-uninstall">Desinstalar</button>
        </div>
      </div>
    `;

    overlay.querySelector('#cancel-uninstall').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#confirm-uninstall').addEventListener('click', () => {
      this.uninstall(appId);
      overlay.remove();
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);
  },

  // Abrir app instalada
  openApp(appId) {
    const app = this.installedApps.get(appId);
    if (!app) return false;

    // Buscar si ya está abierta
    for (const [name, win] of WM.wins) {
      if (win.webAppId === appId || name === app.name) {
        wmFocus(win);
        if (win.minimized) wmToggleMin(win);
        return true;
      }
    }

    // Abrir nueva
    const appDef = Apps.find(a => a.webAppId === appId);
    if (appDef) {
      WM.open(appDef.name);
    }
    return true;
  },

  // Importar desde archivo JSON (backup)
  async importFromFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const data = JSON.parse(e.target.result);
          const results = [];

          if (Array.isArray(data)) {
            for (const app of data) {
              try {
                const result = await this.install(app);
                results.push(result);
              } catch (err) {
                results.push({ success: false, error: err.message, app: app.name });
              }
            }
          } else if (data.id) {
            const result = await this.install(data);
            results.push(result);
          }

          resolve(results);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = reject;
      reader.readAsText(file);
    });
  },

  // Exportar apps instaladas a JSON
  exportToFile() {
    const apps = this.getInstalledApps();
    const json = JSON.stringify(apps, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `webapps-backup-${Date.now()}.json`;
    a.click();

    URL.revokeObjectURL(url);
    OS.toast(`📤 Exportación completa: ${apps.length} apps guardadas`);
  },

  // Buscar apps instaladas
  searchApps(query) {
    const lower = query.toLowerCase();
    return this.getInstalledApps().filter(app =>
      app.name.toLowerCase().includes(lower) ||
      app.description?.toLowerCase().includes(lower) ||
      app.categories?.some(c => c.toLowerCase().includes(lower))
    );
  },

  // Obtener estadísticas
  getStats() {
    const apps = this.getInstalledApps();
    return {
      total: apps.length,
      autoExtracted: apps.filter(a => a.isAutoExtracted).length,
      manual: apps.filter(a => !a.isAutoExtracted).length,
      categories: [...new Set(apps.flatMap(a => a.categories || []))],
      totalSize: 0
    };
  }
};

// Exponer globalmente
window.WebAppManager = WebAppManager;

// Auto-inicializar
document.addEventListener('DOMContentLoaded', () => {
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    WebAppManager.init();
  } else {
    document.addEventListener('readystatechange', () => {
      if (document.readyState === 'complete') WebAppManager.init();
    });
  }
});

// Función global para instalar desde consola
window.installWebApp = (url, options) => WebAppManager.installFromUrl(url, options);