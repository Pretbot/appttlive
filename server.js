require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.json());

// ── Config JSONBin ────────────────────────────────────────────────────────────
const JSONBIN_KEY = process.env.JSONBIN_KEY;
const JSONBIN_BIN = process.env.JSONBIN_BIN;

// ── JSONBin: cargar y guardar apodos ─────────────────────────────────────────
async function cargarApodos() {
    try {
        const res = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN}/latest`, {
            headers: { 'X-Master-Key': JSONBIN_KEY }
        });
        const data = await res.json();
        return data.record.apodos || {};
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
            body: JSON.stringify({ apodos })
        });
    } catch (e) {
        console.error('Error guardando apodos:', e.message);
    }
}

// ── Usuarios vistos en el live ────────────────────────────────────────────────
let usuariosVistos = new Set();
let tiktokLive     = null;

// ── API REST ──────────────────────────────────────────────────────────────────

// Obtener apodos
app.get('/api/apodos', async (req, res) => {
    res.json(await cargarApodos());
});

// Guardar o borrar apodo
app.post('/api/apodos', async (req, res) => {
    const { usuario, apodo } = req.body;
    if (!usuario) return res.status(400).json({ error: 'Usuario requerido' });
    const apodos = await cargarApodos();
    if (apodo && apodo.trim()) {
        apodos[usuario] = apodo.trim();
    } else {
        delete apodos[usuario];
    }
    await guardarApodos(apodos);
    io.emit('apodos_actualizados', apodos); // notifica a la app en tiempo real
    res.json({ ok: true });
});

// Obtener usuarios vistos
app.get('/api/usuarios', async (req, res) => {
    const apodos = await cargarApodos();
    const lista  = Array.from(usuariosVistos).map(u => ({
        usuario: u,
        apodo:   apodos[u] || ''
    }));
    res.json(lista);
});

// ── Panel web de apodos ───────────────────────────────────────────────────────
app.get('/apodos', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TTLIVE — Apodos</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#0d0d0d; color:#fff; font-family:'Segoe UI',sans-serif; padding:30px; }
  h1 { color:#ff2d55; font-size:20px; letter-spacing:3px; margin-bottom:4px; }
  p.sub { color:#888; font-size:12px; margin-bottom:24px; }
  input.search {
    width:100%; max-width:500px; padding:10px 14px;
    background:#111; border:1px solid #2a2a2a; border-radius:8px;
    color:#fff; font-size:14px; margin-bottom:20px; outline:none;
  }
  input.search:focus { border-color:#ff2d55; }
  table { width:100%; max-width:700px; border-collapse:collapse; }
  th { text-align:left; color:#888; font-size:11px; letter-spacing:2px;
       padding:0 0 10px; border-bottom:1px solid #2a2a2a; }
  tr.fila { border-bottom:1px solid #1a1a1a; }
  td { padding:10px 0; vertical-align:middle; }
  td.usuario { color:#ff6b9d; font-size:13px; font-weight:bold;
               max-width:180px; overflow:hidden; text-overflow:ellipsis;
               white-space:nowrap; padding-right:16px; }
  input.apodo-input {
    background:#111; border:1px solid #2a2a2a; border-radius:8px;
    color:#fff; font-size:14px; padding:8px 12px; width:180px; outline:none;
  }
  input.apodo-input:focus { border-color:#ff2d55; }
  button.guardar {
    background:#ff2d55; color:#fff; border:none; border-radius:8px;
    padding:8px 16px; font-size:13px; font-weight:bold;
    cursor:pointer; margin-left:8px; transition:background 0.2s;
  }
  button.guardar:hover { background:#e0002f; }
  button.guardar.ok { background:#69f0ae; color:#000; }
  button.borrar {
    background:transparent; color:#555; border:1px solid #2a2a2a;
    border-radius:8px; padding:8px 12px; font-size:13px;
    cursor:pointer; margin-left:4px; transition:all 0.2s;
  }
  button.borrar:hover { border-color:#ff2d55; color:#ff2d55; }
  .empty { color:#555; font-size:14px; margin-top:30px; }
  .badge {
    display:inline-block; background:#1a1a1a; border:1px solid #2a2a2a;
    border-radius:20px; padding:2px 10px; font-size:11px; color:#69f0ae;
    margin-left:8px;
  }
  .dot { width:8px; height:8px; border-radius:50%;
         background:#00e676; display:inline-block; margin-right:6px; }
</style>
</head>
<body>
<h1>&#9632; TTLIVE APODOS</h1>
<p class="sub">Asigna apodos para que el bot lea correctamente los nombres en voz alta.</p>

<input class="search" type="text" id="buscar" placeholder="Buscar usuario..." oninput="filtrar()">

<table id="tabla">
  <thead>
    <tr>
      <th>USUARIO TIKTOK</th>
      <th>APODO</th>
      <th></th>
    </tr>
  </thead>
  <tbody id="cuerpo">
    <tr><td colspan="3" class="empty">Cargando...</td></tr>
  </tbody>
</table>

<script>
let todos = [];

async function cargar() {
  const res = await fetch('/api/usuarios');
  todos = await res.json();
  renderizar(todos);
}

function renderizar(lista) {
  const tbody = document.getElementById('cuerpo');
  if (!lista.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty">No hay usuarios aún. Espera que alguien comente en el live.</td></tr>';
    return;
  }
  tbody.innerHTML = lista.map(u => \`
    <tr class="fila">
      <td class="usuario" title="\${esc(u.usuario)}">\${esc(u.usuario)}</td>
      <td>
        <input class="apodo-input" type="text"
          id="inp-\${esc(u.usuario)}"
          value="\${esc(u.apodo)}"
          placeholder="Apodo..."
          onkeydown="if(event.key==='Enter') guardar('\${esc(u.usuario)}')">
      </td>
      <td>
        <button class="guardar" id="btn-\${esc(u.usuario)}"
          onclick="guardar('\${esc(u.usuario)}')">Guardar</button>
        \${u.apodo ? \`<button class="borrar" onclick="borrar('\${esc(u.usuario)}')">✕</button>
        <span class="badge">\${esc(u.apodo)}</span>\` : ''}
      </td>
    </tr>
  \`).join('');
}

function filtrar() {
  const q = document.getElementById('buscar').value.toLowerCase();
  renderizar(todos.filter(u =>
    u.usuario.toLowerCase().includes(q) || u.apodo.toLowerCase().includes(q)
  ));
}

async function guardar(usuario) {
  const inp = document.getElementById('inp-' + usuario);
  const btn = document.getElementById('btn-' + usuario);
  const apodo = inp ? inp.value : '';
  const res = await fetch('/api/apodos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario, apodo })
  });
  if (res.ok) {
    btn.textContent = '✓ Guardado';
    btn.classList.add('ok');
    setTimeout(() => { btn.textContent = 'Guardar'; btn.classList.remove('ok'); cargar(); }, 1500);
  }
}

async function borrar(usuario) {
  await fetch('/api/apodos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario, apodo: '' })
  });
  cargar();
}

function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

cargar();
setInterval(cargar, 8000); // refresca cada 8 segundos
</script>
</body>
</html>`);
});

// ── Ruta principal ────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Servidor TTLIVE funcionando 🔥 — Apodos: /apodos"));

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', async (socket) => {
    console.log("📱 App conectada");

    // Enviar apodos actuales al conectarse
    socket.emit('apodos_actualizados', await cargarApodos());

    socket.on('conectar_usuario', async (data) => {
        const username = data.username?.trim();
        if (!username) {
            socket.emit('estado', { ok: false, mensaje: 'Usuario vacío' });
            return;
        }

        console.log(`🔄 Conectando a TikTok LIVE de: ${username}`);

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
                console.log(`Conectado al LIVE de ${username}`);
                socket.emit('estado', { ok: true, mensaje: `Conectado a @${username}` });
            })
            .catch(err => {
                console.error("Error:", err.message);
                socket.emit('estado', { ok: false, mensaje: `No se pudo conectar a @${username}` });
            });

        // 💬 Comentarios
        tiktokLive.on('chat', data => {
            usuariosVistos.add(data.nickname);
            socket.emit('chat', { user: data.nickname, message: data.comment });
        });

        // 🎁 Gifts
        tiktokLive.on('gift', data => {
            if (data.giftType === 1 && !data.repeatEnd) return;
            usuariosVistos.add(data.nickname);
            socket.emit('gift', {
                user: data.nickname, gift: data.giftName,
                cantidad: data.repeatCount || 1, diamantes: data.diamondCount || 0
            });
        });

        // ❤️ Likes
        tiktokLive.on('like', data => {
            usuariosVistos.add(data.nickname);
            socket.emit('like', { user: data.nickname, cantidad: data.likeCount });
        });

        // 👤 Follow
        tiktokLive.on('follow', data => {
            usuariosVistos.add(data.nickname);
            socket.emit('follow', { user: data.nickname });
        });

        // 🔔 Suscriptor
        tiktokLive.on('subscribe', data => {
            usuariosVistos.add(data.nickname);
            socket.emit('subscribe', { user: data.nickname });
        });

        // 🔁 Compartir
        tiktokLive.on('share', data => {
            usuariosVistos.add(data.nickname);
            socket.emit('share', { user: data.nickname });
        });
    });

    socket.on('disconnect', () => {
        console.log("📴 App desconectada");
        if (tiktokLive) { tiktokLive.disconnect(); tiktokLive = null; }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
