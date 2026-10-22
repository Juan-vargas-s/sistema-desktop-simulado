// ============================================================
// SimSys OS — navegadores internos (receta "Sistema Móvil")
// <webview> plano con partición persistente, tal como funciona
// en el proyecto Sistema Móvil: Telegram / WhatsApp Web y el
// Navegador viven DENTRO de las ventanas del escritorio y todo
// se comporta como un navegador real (URL, búsqueda, atrás,
// adelante, recargar, página de inicio).
// ============================================================
'use strict';

const WEB_PARTITION = 'persist:webapps'; // sesión persistente (cookies/login)
const SEARCH_GOOGLE = 'https://www.google.com/search?q=';

/* Convierte lo escrito en la barra en URL navegable (o null → búsqueda en Google) */
OSApp.normalizeUrl = function (input) {
  const v = String(input || '').trim();
  if (!v) return SEARCH_GOOGLE + '';
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(v)) return 'https://' + v;
  return null;
};


/* Monta un “navegador interno” dentro del cuerpo de una ventana
   (equivalente a WindowManager.createWebview del Sistema Móvil) */
function mountWebview(body, win, initialUrl) {
  body.innerHTML = '';
  body.style.padding = '0';
  body.style.background = '#12182e';
  body.style.display = 'flex';
  body.style.flexDirection = 'column';
  body.style.overflow = 'hidden';

  // —— barra superior con URL y controles (como el navegador móvil) ——
  const bar = document.createElement('div');
  bar.style.cssText = 'flex:0 0 auto;display:flex;align-items:center;gap:7px;padding:8px 10px;background:#f1f3f5;border-bottom:1px solid #e0e0e0';
  bar.innerHTML = `
    <button title="Atrás" style="border:none;background:none;font-size:15px;cursor:pointer">◀</button>
    <button title="Adelante" style="border:none;background:none;font-size:15px;cursor:pointer">▶</button>
    <button title="Recargar" style="border:none;background:none;font-size:14px;cursor:pointer">⟳</button>
    <button title="Inicio" style="border:none;background:none;font-size:14px;cursor:pointer">⌂</button>
    <input spellcheck="false" placeholder="Busca en Google o escribe una URL..."
      style="flex:1;padding:8px 12px;border:none;border-radius:16px;background:white;font-size:12.5px;outline:none;box-shadow:inset 0 0 0 1px #ddd">
    <button title="Ir" style="border:none;background:none;font-size:15px;cursor:pointer">➡️</button>`;

  // —— área del webview ——

  const wrap = document.createElement('div');
  wrap.style.cssText = 'flex:1 1 auto;position:relative;overflow:hidden;background:#fff';

  const wv = document.createElement('webview');
  wv.setAttribute('src', initialUrl); // igual que el Sistema Móvil: la carga la inicia src
  wv.setAttribute('allowpopups', 'true');
  wv.setAttribute('partition', WEB_PARTITION);
  wv.setAttribute('webpreferences', 'contextIsolation=no,nodeIntegration=no');
  wv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:none;background:#fff';

  // indicador de carga (igual que el móvil)
  const loading = document.createElement('div');
  loading.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;gap:12px;align-items:center;justify-content:center;background:#fff;color:#667;font-size:13px;z-index:5';
  loading.innerHTML = '<div style="width:34px;height:34px;border:4px solid #d7dce6;border-top-color:#3861ff;border-radius:50%;animation:wv-spin 0.8s linear infinite"></div><div>cargando página…</div>';
  const styleSpin = document.createElement('style');
  styleSpin.textContent = '@keyframes wv-spin{to{transform:rotate(360deg)}}';
  document.head.appendChild(styleSpin);

  // overlay de error con reintento
  const errBox = document.createElement('div');
  errBox.style.cssText = 'position:absolute;inset:0;display:none;flex-direction:column;gap:10px;align-items:center;justify-content:center;background:#fff;color:#334;z-index:6';
  errBox.innerHTML = `
    <div style="font-size:40px">🔌</div>
    <div style="font-weight:600">No se pudo cargar la página</div>
    <div class="wv-errdesc" style="color:#8891a8;font-size:12px;text-align:center;max-width:420px"></div>
    <div style="color:#8891a8;font-size:12px">¿Tienes conexión a internet?</div>
    <button style="padding:9px 22px;border:none;border-radius:18px;background:#3861ff;color:#fff;font-size:13px;cursor:pointer">Reintentar</button>`;
  errBox.querySelector('button').onclick = () => { errBox.style.display = 'none'; loading.style.display = 'flex'; wv.reload(); };
  wrap.append(wv, loading, errBox);
  body.append(bar, wrap);

  const addr = bar.querySelector('input');
  addr.value = initialUrl;
  const [backBtn, fwdBtn, rlBtn, homeBtn, goBtn] = bar.querySelectorAll('button');

  const normalizeOrSearch = (input) => OSApp.normalizeUrl(input) || (SEARCH_GOOGLE + encodeURIComponent(input));

  const nav = () => {
    const url = normalizeOrSearch(addr.value);
    if (!url) return;
    addr.value = url;
    errBox.style.display = 'none';
    loading.style.display = 'flex';
    wv.src = url; // igual que el móvil
  };

  const navHist = (dir) => {
    try {
      if (dir === 'b') wv.navigationHistory?.goBack ? wv.navigationHistory.goBack() : wv.goBack();
      else wv.navigationHistory?.goForward ? wv.navigationHistory.goForward() : wv.goForward();
    } catch (_) { /* sin historial */ }
  };

  backBtn.onclick = () => navHist('b');
  fwdBtn.onclick = () => navHist('f');
  rlBtn.onclick = () => { loading.style.display = 'flex'; errBox.style.display = 'none'; wv.reload(); };
  homeBtn.onclick = () => { errBox.style.display = 'none'; loading.style.display = 'flex'; wv.src = 'https://www.google.com'; };
  goBtn.onclick = nav;
  addr.addEventListener('keydown', (e) => { if (e.key === 'Enter') { nav(); e.preventDefault(); e.stopPropagation(); } });

  // —— eventos del guest ——
  wv.addEventListener('did-start-loading', () => { loading.style.display = 'flex'; });
  wv.addEventListener('did-stop-loading', () => { loading.style.display = 'none'; });
  wv.addEventListener('did-finish-load', () => { loading.style.display = 'none'; });
  wv.addEventListener('did-navigate', (e) => { if (document.activeElement !== addr) addr.value = e.url; });
  wv.addEventListener('did-navigate-in-page', (e) => { if (document.activeElement !== addr) addr.value = e.url; });
  wv.addEventListener('page-title-updated', (e) => {
    const w = WM.wins.get(win.appId);
    if (w) w.root.querySelector('.t-title').textContent = win.appId + ' — ' + (e.title || '').slice(0, 42);
    if (typeof wmRenderTasks === 'function') wmRenderTasks();
  });
  wv.addEventListener('did-fail-load', (e) => {
    if (!e.isMainFrame || e.errorCode === -3) return; // -3 = interrupción benigna
    loading.style.display = 'none';
    errBox.querySelector('.wv-errdesc').textContent = String(e.errorDesc || e.errorCode).slice(0, 80);
    errBox.style.display = 'flex';
  });

  return { wv };
}

/* Fábrica de apps con navegador interno */
function webWindowApp(name, icon, homeUrl) {
  return {
    name, icon,
    w: 1080, h: 720,
    launch(body, win) {
      mountWebview(body, win, homeUrl);
    },
  };
}

const App_WebTelegram = webWindowApp('Telegram Web', '✈️', 'https://web.telegram.org/k/');
const App_WebWhatsApp = webWindowApp('WhatsApp Web', '💬', 'https://web.whatsapp.com/');

/* ---------- Navegador web integrado (búsquedas en línea) ---------- */
const AppBrowser = {
  name: 'Navegador Web',
  icon: '🌍',
  w: 1080, h: 720,
  launch(body, win) {
    // URLs o búsquedas pendientes desde la terminal ("browse …" / "open …")
    const pendingUrl = OSApp._pendingUrl; OSApp._pendingUrl = null;
    const q = OSApp._pendingQuery; OSApp._pendingQuery = null;
    let url = pendingUrl || null;
    if (!url && q) url = SEARCH_GOOGLE + encodeURIComponent(q);
    mountWebview(body, win, url || 'https://www.google.com'); // página por defecto: Google
  },
};

// registrar las apps de navegador en el escritorio
Apps.push(AppBrowser, App_WebTelegram, App_WebWhatsApp);
