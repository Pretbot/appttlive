const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.get("/", (req, res) => res.send("Servidor TTLIVE funcionando 🔥"));

let tiktokLive = null;

io.on('connection', (socket) => {
    console.log("📱 App conectada");

    socket.on('conectar_usuario', (data) => {
        const username = data.username?.trim();
        if (!username) {
            socket.emit('estado', { ok: false, mensaje: '❌ Usuario vacío' });
            return;
        }

        console.log(`🔄 Conectando a TikTok LIVE de: ${username}`);

        if (tiktokLive) {
            tiktokLive.disconnect();
            tiktokLive = null;
        }

        tiktokLive = new WebcastPushConnection(username, {
            processInitialData: true,
            enableExtendedGiftInfo: true,
            enableWebsocketUpgrade: true,
            requestPollingIntervalMs: 2000,
            disableEulerFallbacks: true
        });

        tiktokLive.connect()
            .then(() => {
                console.log(`Conectado al LIVE de ${username}`);
                socket.emit('estado', { ok: true, mensaje: `Conectado a @${username}` });
            })
            .catch(err => {
                console.error("Error:", err.message);
                socket.emit('estado', { ok: false, mensaje: `No se pudo conectar a @${username}` });
            });

        // 💬 Comentarios
        tiktokLive.on('chat', data => {
            socket.emit('chat', {
                user: data.nickname,
                message: data.comment
            });
        });

        // 🎁 Gifts
        tiktokLive.on('gift', data => {
            if (data.giftType === 1 && !data.repeatEnd) return;
            socket.emit('gift', {
                user: data.nickname,
                gift: data.giftName,
                cantidad: data.repeatCount || 1,
                diamantes: data.diamondCount || 0
            });
        });

        // ❤️ Likes
        tiktokLive.on('like', data => {
            socket.emit('like', {
                user: data.nickname,
                cantidad: data.likeCount
            });
        });

        // 👤 Nuevo seguidor
        tiktokLive.on('follow', data => {
            socket.emit('follow', {
                user: data.nickname
            });
        });

        // 🔔 Nuevo suscriptor
        tiktokLive.on('subscribe', data => {
            socket.emit('subscribe', {
                user: data.nickname
            });
        });

        // 🔁 Compartir
        tiktokLive.on('share', data => {
            socket.emit('share', {
                user: data.nickname
            });
        });
    });

    socket.on('disconnect', () => {
        console.log("📴 App desconectada");
        if (tiktokLive) {
            tiktokLive.disconnect();
            tiktokLive = null;
        }
    });
});

// ✅ Railway asigna el puerto por variable de entorno
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
