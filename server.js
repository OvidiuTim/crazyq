const path = require('node:path');
const http = require('node:http');

const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const publicDirectory = path.join(__dirname, 'public');

// Sesiunile sunt volatile în această etapă și dispar când serverul este repornit.
const sessions = new Map();
const hostedSessionBySocket = new Map();
const playerSessionBySocket = new Map();

app.use(express.static(publicDirectory));

app.get('/', (_request, response) => {
  response.redirect('/play');
});

app.get('/admin', (_request, response) => {
  response.sendFile(path.join(publicDirectory, 'admin.html'));
});

app.get('/play', (_request, response) => {
  response.sendFile(path.join(publicDirectory, 'play.html'));
});

function normalizeSessionCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function normalizePlayerName(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function generateSessionCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = '';

    for (let index = 0; index < 4; index += 1) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }

    if (!sessions.has(code)) {
      return code;
    }
  }

  throw new Error('Nu s-a putut genera un cod unic de sesiune.');
}

function serializePlayers(session) {
  return Array.from(session.players.values()).map(({ id, name }) => ({ id, name }));
}

function sendPlayersToHost(session) {
  io.to(session.hostSocketId).emit('session:players', {
    code: session.code,
    players: serializePlayers(session),
  });
}

function removePlayerFromCurrentSession(socketId) {
  const sessionCode = playerSessionBySocket.get(socketId);

  if (!sessionCode) {
    return;
  }

  const session = sessions.get(sessionCode);
  playerSessionBySocket.delete(socketId);
  io.sockets.sockets.get(socketId)?.leave(`session:${sessionCode}`);

  if (!session || !session.players.delete(socketId)) {
    return;
  }

  sendPlayersToHost(session);
}

function closeHostedSession(socketId) {
  const sessionCode = hostedSessionBySocket.get(socketId);

  if (!sessionCode) {
    return;
  }

  const session = sessions.get(sessionCode);
  hostedSessionBySocket.delete(socketId);

  if (!session) {
    return;
  }

  for (const playerId of session.players.keys()) {
    playerSessionBySocket.delete(playerId);
  }

  io.to(`session:${sessionCode}`).emit('session:closed');
  sessions.delete(sessionCode);
}

io.on('connection', (socket) => {
  socket.on('session:create', (_payload, reply) => {
    const respond = typeof reply === 'function' ? reply : () => {};

    try {
      // Un host păstrează o singură sesiune activă în această versiune.
      closeHostedSession(socket.id);

      const code = generateSessionCode();
      const session = {
        code,
        hostSocketId: socket.id,
        players: new Map(),
        createdAt: Date.now(),
      };

      sessions.set(code, session);
      hostedSessionBySocket.set(socket.id, code);
      socket.join(`session:${code}`);

      respond({ ok: true, session: { code } });
      sendPlayersToHost(session);
    } catch (error) {
      console.error(error);
      respond({ ok: false, error: 'Sesiunea nu a putut fi creată. Încearcă din nou.' });
    }
  });

  socket.on('player:join', (payload, reply) => {
    const respond = typeof reply === 'function' ? reply : () => {};
    const code = normalizeSessionCode(payload?.sessionCode);
    const name = normalizePlayerName(payload?.name);

    if (!/^[A-Z0-9]{4}$/.test(code)) {
      respond({ ok: false, error: 'Codul trebuie să aibă 4 caractere.' });
      return;
    }

    if (!name) {
      respond({ ok: false, error: 'Scrie numele tău ca să poți intra.' });
      return;
    }

    if (name.length > 30) {
      respond({ ok: false, error: 'Numele poate avea cel mult 30 de caractere.' });
      return;
    }

    const session = sessions.get(code);

    if (!session) {
      respond({ ok: false, error: 'Sesiunea nu există. Verifică atent codul.' });
      return;
    }

    removePlayerFromCurrentSession(socket.id);

    const player = { id: socket.id, name, joinedAt: Date.now() };
    session.players.set(socket.id, player);
    playerSessionBySocket.set(socket.id, code);
    socket.join(`session:${code}`);

    respond({ ok: true, session: { code }, player: { id: player.id, name: player.name } });
    sendPlayersToHost(session);
  });

  socket.on('disconnect', () => {
    removePlayerFromCurrentSession(socket.id);
    closeHostedSession(socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`CrazyQ rulează pe http://localhost:${PORT}`);
});
