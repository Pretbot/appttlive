require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const { WebcastPushConnection } = require('tiktok-live-connector');
const TelegramBot = require('node-telegram-bot-api');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.json());

// ── Config ────────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const JSONBIN_KEY      = process.env.JSONBIN_KEY;
const JSONBIN_BIN      = process.env.JSONBIN_BIN;

// ── JSONBin — apodos persistentes ─────────────────────────────────────────────
async function cargarApodos() {
    try {
        const res = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN}/latest`, {
            headers: { 'X-Master-Key': JSONBIN_KEY }
        });
        const data = await res.json();
        return data.record || {};
    } catch (e) { return {}; }
}

async function guardarApodos(apodos) {
    try {
        await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Master-Key': JSONBIN_KEY
            },
            body: JSON.stringify(apodos)
        });
    } catch (e) {
        console.error('Error guardando apodos:', e.message);
    }
}

// ── Telegram Bot ──────────────────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

function notificarTelegram(texto) {
    bot.sendMessage(TELEGRAM_CHAT_ID, texto).catch(() => {});
}

// /start o /ayuda
bot.onText(/\/start|\/ayuda/, (msg) => {
    if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
    bot.sendMessage(msg.chat.id,
`🤖 TTLIVE Bot — Comandos:

/apodo [usuario] [nombre]
  Asigna apodo a un usuario
  Ejemplo: /apodo ⚡_Ryan_⚡ Ryan

/ver
  Lista todos los apodos guardados

/borrar [usuario]
  Elimina el apodo de un usuario

/ayuda
  Muestra este mensaje`
    );
});

// /apodo usuario apodo
bot.onText(/\/apodo (.+)/, async (msg, match) => {
    if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
    const partes  = match[1].trim().split(' ');
    if (partes.length < 2) {
        bot.sendMessage(msg.chat.id, '❌ Uso: /apodo usuario_tiktok Apodo\nEjemplo: /apodo ⚡_Ryan_⚡ Ryan');
        return;
    }
    const usuario = partes[0];
    const apodo   = partes.slice(1).join(' ');
    const apodos  = await cargarApodos();
    apodos[usuario] = apodo;
    await guardarApodos(apodos);
    io.emit('apodos_actualizados', apodos);
    bot.sendMessage(msg.chat.id, `✅ Guardado:\n👤 ${usuario}\n→ ${apodo}`);
});

// /ver
bot.onText(/\/ver/, async (msg) => {
    if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
    const apodos = await cargarApodos();
    const lista  = Object.entries(apodos);
    if (lista.length === 0) {
        bot.sendMessage(msg.chat.id, '📭 No hay apodos guardados.');
        return;
    }
    const texto = lista.map(([u, a]) => `👤 ${u} → ${a}`).join('\n');
    bot.sendMessage(msg.chat.id, `📋 Apodos:\n\n${texto}`);
});

// /borrar usuario
bot.onText(/\/borrar (.+)/, async (msg, match) => {
    if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
    const usuario = match[1].trim();
    const apodos  = await cargarApodos();
    if (!apodos[usuario]) {
        bot.sendMessage(msg.chat.id, `❌ No existe apodo para: ${usuario}`);
        return;
    }
    delete apodos[usuario];
    await guardarApodos(apodos);
    io.emit('apodos_actualizados', apodos);
    bot.sendMessage(msg.chat.id, `🗑️ Eliminado: ${usuario}`);
});

// ── Variables de estado ───────────────────────────────────────────────────────
let usuariosVistos = new Set();
let tiktokLive     = null;

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', async (socket) => {
    console.log("📱 App conectada");
    socket.emit('apodos_actualizados', await cargarApodos());

    socket.on('conectar_usuario', async (data) => {
        const username = data.username?.trim();
        if (!username) {
            socket.emit('estado', { ok: false, mensaje: 'Usuario vacío' });
            return;
        }

        if (tiktokLive) { tiktokLive.disconnect(); tiktokLive = null; }

        tiktokLive = new WebcastPushConnection(username, {
            processInitialData: true,
            enableExtendedGiftInfo: true,
            enableWebsocketUpgrade: true,
            requestPollingIntervalMs: 2000,
            disableEulerFallbacks: true
        });

        tiktokLive.connect()
            .then(() => {
                socket.emit('estado', { ok: true, mensaje: `Conectado a @${username}` });
                notificarTelegram(`🟢 Live conectado: @${username}`);
            })
            .catch(err => {
                socket.emit('estado', { ok: false, mensaje: `Error: ${err.message}` });
                notificarTelegram(`🔴 Error: ${err.message}`);
            });

        tiktokLive.on('chat', async data => {
            usuariosVistos.add(data.nickname);
            socket.emit('chat', { user: data.nickname, message: data.comment });
        });

        tiktokLive.on('gift', async data => {
            if (data.giftType === 1 && !data.repeatEnd) return;
            usuariosVistos.add(data.nickname);
            socket.emit('gift', {
                user: data.nickname, gift: data.giftName,
                cantidad: data.repeatCount || 1,
                diamantes: data.diamondCount || 0
            });
            notificarTelegram(
                `🎁 ${data.nickname} envió ${data.repeatCount}x ${data.giftName} (${data.diamondCount} 💎)`
            );
        });

        tiktokLive.on('like', data => {
            usuariosVistos.add(data.nickname);
            socket.emit('like', { user: data.nickname, cantidad: data.likeCount });
        });

        tiktokLive.on('follow', data => {
            usuariosVistos.add(data.nickname);
            socket.emit('follow', { user: data.nickname });
            notificarTelegram(`👤 Nuevo follow: ${data.nickname}`);
        });

        tiktokLive.on('subscribe', data => {
            usuariosVistos.add(data.nickname);
            socket.emit('subscribe', { user: data.nickname });
            notificarTelegram(`🔔 Suscripción: ${data.nickname}`);
        });
    });

    socket.on('disconnect', () => {
        if (tiktokLive) { tiktokLive.disconnect(); tiktokLive = null; }
    });
});

app.get("/", (req, res) => res.send("TTLIVE Server 🔥"));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Puerto ${PORT}`));