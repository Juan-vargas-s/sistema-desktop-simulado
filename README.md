# 🧠 SimSys OS — Simulador de Sistema Operativo de Escritorio

Aplicación en **Electron** que simula el funcionamiento interno de un sistema
operativo: planificación de procesos con **quantum**, administración de
**memoria**, **CPU**, **disco duro** y **dispositivos de E/S**,
detección de **interbloqueo**, evidencia de **inanición**, sincronización con
**semáforos**, terminal, explorador de archivos, gráficas por selección de
usuario y aplicaciones de escritorio reales (con mensajería web: **Telegram
Web** y **WhatsApp Web** abren su versión web en ventanas propias de la app).

## 🚀 Ejecutar

```bash
npm install     # instala electron (una sola vez)
npm start       # lanza el simulador
```

Prueba automática del núcleo (sin interfaz):

```bash
npm run test-kernel
```

## 📦 Requisitos cubiertos (según enunciado)

| Requisito | Dónde se evidencia |
|---|---|
| Funciones de un SO de escritorio | Escritorio con ventanas, barra de tareas, menú «Inicio», iconos, menú contextual, reloj y arranque tipo BIOS |
| ≥ 10 procesos | 14 procesos iniciales (`init`, `rtkernel`, antivirus, indexador, compositor, servicio-red, multimedia, editor, telemetría, cola-impresión, backup, asistente-IA, productor y consumidor) + creación de procesos nuevos |
| Quantum por proceso | Cada proceso tiene su propio `quantum` (visible/editable en el monitor y desde la terminal con `quantum <pid> <q>`) |
| Existencia de interbloqueo | Grafo de asignación de recursos + bucle de espera circular detectado cada 8 ticks: banner rojo, LED en la barra, diálogo «Ver grafo de espera», registro `[DEADLOCK]` y resolución (abortar víctima) |
| Evidencia de inanición | Contador de espera de cada proceso en estado LISTO: al superar el umbral se marca ⭐, se registra `[starve]` y se aplica *envejecimiento* (aging) subiendo prioridad |
| Administración de recursos | CPU (2 núcleos + CPU física real), memoria RAM, disco duro (archivos y ocupación) y 5 dispositivos de E/S con instancias (disco, impresoras ×2, escáner, cámara, red) |
| Técnica de administración de memoria | Particiones dinámicas con **primer / mejor ajuste** y **COMPACTACIÓN** (manual o automática), además de área de swap para procesos suspendidos |
| Existencia de fragmentación | Fragmentación **interna** (redondeo de bloques de 8 MB) y **externa** (huecos y % de dispersión) en la app «Gestión de Memoria» |
| Gráficas por selección de usuario | Monitor: series CPU/Memoria/E/S con casillas de verificación + franja Gantt + gráfica por proceso (selección de PIDs); gráfica de pastel de memoria |
| Visualización del flujo y estados | App «Estados y Flujo del SO»: estados Nuevo→Listo→Ejecución→Bloqueado→Suspendido→Terminado con transiciones resaltadas, semáforos, buffer compartido productor/consumidor y registro de eventos del núcleo |
| Info del proceso | PID, icono, estado, prioridad, quantum restante, memoria asignada, dispositivos asignados/esperados, tiempo de espera |
| Control de hardware | App «Recursos y Hardware»: CPU real (núcleos y uso por núcleo), RAM real, disco real (por peticiones del SO anfitrión) + hardware simulado |
| Mensajería web | Menú Inicio / iconos: **Telegram Web** (`web.telegram.org`) y **WhatsApp Web** (`web.whatsapp.com`) embebidos DENTRO de las ventanas del escritorio, con sesión persistente |
| Navegador interno | App **🌍 Navegador Web**: barra de direcciones (URLs y búsquedas en línea vía DuckDuckGo), atrás/adelante/recargar, página de inicio propia; la terminal lo abre con `open <url>` o `browse <búsqueda>` |
| Sistema de archivos | VFS jerárquico (`/bin`, `/etc`, `/home/juan`, `/proc` con estado en vivo del núcleo, `/var/log/…`) navegable desde la terminal (`ls`, `cd`, `cat`, `pwd`, `tree`, `find`, `echo >/>>`, `mkdir`, `touch`, `mv`, `rm`, `df`) y desde el Explorador de Archivos |

## 🖥️ Aplicaciones del piso (escritorio)

- **📊 Monitor de Procesos**: tabla completa, acciones por fila (terminar, prioridad ▲▼, suspender/reanudar), crear procesos, métricas del núcleo y gráficas.
- **🧠 Gestión de Memoria**: mapa de bloques por PID, huecos, fragmentación interna/externa, compactar, estrategia first-fit/best-fit, gráfica de pastel.
- **🖥️ Recursos y Hardware**: instancias por dispositivo y cola de espera, núcleos de CPU simulados y datos del hardware físico real.
- **📁 Explorador de Archivos**: árbol del sistema de archivos virtual (coincide con la terminal; doble clic muestra el contenido, incluidos los archivos virtuales en vivo de `/proc`) + archivos generados por los procesos en el disco duro simulado.
- **⌨️ Terminal**: `help fs-help ps top kill nice quantum create suspend resume mem compact dev disk df pwd ls cd cat echo touch mkdir rm mv tree find open browse deadlock strat pause resume-sys uptime clear exit`.
- **🔄 Estados y Flujo del SO**: diagrama de estados/transiciones, semáforos, buffer compartido, registro de eventos colorido.
- **⚙️ Ajustes del Núcleo**: velocidad del reloj, umbral de inanición, compactación automática, resolución automática de interbloqueos, probabilidades de E/S y de recursos.
- **🌍 Navegador Web / ✈️ Telegram Web / 💬 WhatsApp Web**: contenido web real embebido dentro de las ventanas del escritorio (`<webview>` con sesión persistente, al estilo del proyecto «Sistema Móvil»), con barra de direcciones, búsqueda en Google, atrás/adelante/recargar/inicio y pantalla de error con reintento.

## 🧩 Arquitectura

```
main.js        → proceso principal: ventana, hardware real (os/fs),
                 ventanas web con sesión persistente (Telegram/WhatsApp)
preload.js     → puente seguro (contextBridge) hacia el simulador
kernel.js      → motor de simulación (usable también en Node):
                 planificador RR por prioridades + quantums, memoria con
                 compactación, dispositivos con instancias, detección de
                 interbloqueo por ciclos, aging contra inanición, semáforos
renderer/
  index.html   → arranque (BIOS simulada) + escritorio
  styles.css   → tema oscuro del escritorio
  charts.js    → gráficas en <canvas>: líneas, barras, Gantt, dona
  apps.js      → implementación de las apps + diálogos (terminal, apps del núcleo)
  webview.js   → navegadores internos (Navegador, Telegram, WhatsApp):
                 <webview> con partición persistente (receta "Sistema Móvil",
                 nodeIntegration en el host para que renderice a tamaño real),
                 barra de direcciones con búsqueda en Google y controles
  desktop.js   → gestor de ventanas, barra de tareas, menú de inicio,
                 reloj, toasts, banner de interbloqueo, bucle del núcleo
test-kernel.js → prueba automática del motor (npm run test-kernel)
```

Autor: proyecto académico — la interfaz y el motor son 100 % JavaScript/HTML/CSS.
