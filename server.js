const path = require('node:path');
const http = require('node:http');

const express = require('express');
const { Server } = require('socket.io');

const { db, importResult } = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ANSWER_DURATION_SECONDS = Math.max(
  1,
  Number.parseInt(process.env.ANSWER_DURATION_SECONDS, 10) || 15,
);
const QUESTIONS_PER_GAME = 10;
const MAX_NAME_LENGTH = 30;
const MAX_ANSWER_LENGTH = 280;
const publicDirectory = path.join(__dirname, 'public');

// Timerul și socket-ul hostului sunt efemere; jocul propriu-zis rămâne în SQLite.
const runtimeSessions = new Map();

app.use(express.static(publicDirectory));

app.get('/', (_request, response) => response.redirect('/play'));
app.get('/admin', (_request, response) => response.sendFile(path.join(publicDirectory, 'admin.html')));
app.get('/play', (_request, response) => response.sendFile(path.join(publicDirectory, 'play.html')));

function normalizeSessionCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function normalizePlayerName(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function normalizeAnswer(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function sessionRoom(code) {
  return `session:${code}`;
}

function getSession(code) {
  return db.prepare('SELECT * FROM sessions WHERE code = ? COLLATE NOCASE').get(code);
}

function getRuntime(code) {
  if (!runtimeSessions.has(code)) {
    runtimeSessions.set(code, {
      hostSocketId: null,
      answerDeadline: null,
      answerTimer: null,
    });
  }

  return runtimeSessions.get(code);
}

function generateSessionCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  for (let attempt = 0; attempt < 200; attempt += 1) {
    let code = '';

    for (let index = 0; index < 4; index += 1) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }

    if (!getSession(code)) {
      return code;
    }
  }

  throw new Error('Nu s-a putut genera un cod unic de sesiune.');
}

function getCurrentQuestion(session) {
  if (!session || session.current_question_index < 0) {
    return null;
  }

  return db.prepare(`
    SELECT q.id, q.text, sq.position
    FROM session_questions sq
    JOIN questions q ON q.id = sq.question_id
    WHERE sq.session_id = ? AND sq.position = ?
  `).get(session.id, session.current_question_index) || null;
}

function getQuestionCount(sessionId) {
  return db.prepare(`
    SELECT COUNT(*) AS count
    FROM session_questions
    WHERE session_id = ?
  `).get(sessionId).count;
}

function getSessionPlayers(sessionId) {
  return db.prepare(`
    SELECT id, name, socket_id AS socketId
    FROM players
    WHERE session_id = ?
    ORDER BY name COLLATE NOCASE ASC, id ASC
  `).all(sessionId).map((player) => ({
    id: player.id,
    name: player.name,
    connected: Boolean(player.socketId && io.sockets.sockets.has(player.socketId)),
  }));
}

function getAnswerCount(sessionId, questionId) {
  if (!questionId) {
    return 0;
  }

  return db.prepare(`
    SELECT COUNT(*) AS count
    FROM answers
    WHERE session_id = ? AND question_id = ?
  `).get(sessionId, questionId).count;
}

function getVoteCount(sessionId, questionId) {
  if (!questionId) {
    return 0;
  }

  return db.prepare(`
    SELECT COUNT(*) AS count
    FROM votes
    WHERE session_id = ? AND question_id = ?
  `).get(sessionId, questionId).count;
}

function getVotingAnswers(sessionId, questionId) {
  return db.prepare(`
    SELECT a.id, a.text, a.player_id AS playerId, p.name AS authorName
    FROM answers a
    JOIN players p ON p.id = a.player_id
    WHERE a.session_id = ? AND a.question_id = ?
    ORDER BY a.id ASC
  `).all(sessionId, questionId);
}

function getQuestionResults(sessionId, questionId) {
  return db.prepare(`
    SELECT
      a.id,
      a.text,
      a.player_id AS playerId,
      p.name AS authorName,
      COUNT(v.id) AS voteCount
    FROM answers a
    JOIN players p ON p.id = a.player_id
    LEFT JOIN votes v ON v.answer_id = a.id
    WHERE a.session_id = ? AND a.question_id = ?
    GROUP BY a.id
    ORDER BY voteCount DESC, p.name COLLATE NOCASE ASC, a.id ASC
  `).all(sessionId, questionId);
}

function getLeaderboard(sessionId) {
  return db.prepare(`
    SELECT p.id, p.name, COUNT(v.id) AS score
    FROM players p
    LEFT JOIN answers a
      ON a.player_id = p.id AND a.session_id = p.session_id
    LEFT JOIN votes v
      ON v.answer_id = a.id AND v.session_id = p.session_id
    WHERE p.session_id = ?
    GROUP BY p.id
    ORDER BY score DESC, p.name COLLATE NOCASE ASC, p.id ASC
  `).all(sessionId).map((player, index) => ({
    id: player.id,
    name: player.name,
    score: player.score,
    rank: index + 1,
  }));
}

function getRemainingSeconds(code) {
  const deadline = getRuntime(code).answerDeadline;
  return deadline ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : 0;
}

function buildBaseState(session) {
  const question = getCurrentQuestion(session);
  const totalQuestions = getQuestionCount(session.id);

  return {
    session: {
      code: session.code,
      status: session.status,
      currentQuestionIndex: session.current_question_index,
      totalQuestions,
    },
    question: question ? {
      id: question.id,
      text: question.text,
      number: question.position + 1,
      total: totalQuestions,
    } : null,
    timer: {
      remaining: session.status === 'answering' ? getRemainingSeconds(session.code) : 0,
      deadline: getRuntime(session.code).answerDeadline,
    },
  };
}

function buildAdminState(session) {
  const base = buildBaseState(session);
  const players = getSessionPlayers(session.id);
  const questionId = base.question?.id;
  const state = {
    ...base,
    players,
    progress: {
      playersTotal: players.length,
      playersConnected: players.filter((player) => player.connected).length,
      answersSubmitted: getAnswerCount(session.id, questionId),
      votesSubmitted: getVoteCount(session.id, questionId),
    },
  };

  if (session.status === 'voting') {
    state.answers = getVotingAnswers(session.id, questionId).map(({ id, text, authorName }) => ({
      id,
      text,
      authorName,
    }));
  }

  if (session.status === 'question_result') {
    state.results = getQuestionResults(session.id, questionId);
  }

  if (session.status === 'finished') {
    state.leaderboard = getLeaderboard(session.id);
  }

  return state;
}

function buildPlayerState(session, playerId) {
  const base = buildBaseState(session);
  const questionId = base.question?.id;
  const state = { ...base };

  if (session.status === 'answering' && questionId) {
    const answer = db.prepare(`
      SELECT id
      FROM answers
      WHERE session_id = ? AND question_id = ? AND player_id = ?
    `).get(session.id, questionId, playerId);

    state.hasAnswered = Boolean(answer);
  }

  if (session.status === 'voting' && questionId) {
    const vote = db.prepare(`
      SELECT answer_id AS answerId
      FROM votes
      WHERE session_id = ? AND question_id = ? AND voter_player_id = ?
    `).get(session.id, questionId, playerId);

    state.hasVoted = Boolean(vote);
    state.votedAnswerId = vote?.answerId || null;
    state.answers = getVotingAnswers(session.id, questionId).map(({ id, text, playerId: authorId }) => ({
      id,
      text,
      isOwn: authorId === playerId,
    }));
  }

  if (session.status === 'question_result') {
    state.results = getQuestionResults(session.id, questionId);
  }

  if (session.status === 'finished') {
    state.leaderboard = getLeaderboard(session.id);
  }

  return state;
}

function emitAdminState(code) {
  const session = getSession(code);

  if (!session) {
    return;
  }

  const runtime = getRuntime(session.code);

  if (runtime.hostSocketId && io.sockets.sockets.has(runtime.hostSocketId)) {
    io.to(runtime.hostSocketId).emit('admin:state', buildAdminState(session));
  }
}

function emitPlayerState(code, playerId) {
  const session = getSession(code);

  if (!session) {
    return;
  }

  const player = db.prepare(`
    SELECT socket_id AS socketId
    FROM players
    WHERE id = ? AND session_id = ?
  `).get(playerId, session.id);

  if (player?.socketId && io.sockets.sockets.has(player.socketId)) {
    io.to(player.socketId).emit('game:state', buildPlayerState(session, playerId));
  }
}

function emitState(code) {
  const session = getSession(code);

  if (!session) {
    return;
  }

  emitAdminState(session.code);

  const connectedPlayers = db.prepare(`
    SELECT id, socket_id AS socketId
    FROM players
    WHERE session_id = ? AND socket_id IS NOT NULL
  `).all(session.id);

  for (const player of connectedPlayers) {
    if (io.sockets.sockets.has(player.socketId)) {
      emitPlayerState(session.code, player.id);
    }
  }
}

function clearAnswerTimer(code) {
  const runtime = getRuntime(code);

  if (runtime.answerTimer) {
    clearInterval(runtime.answerTimer);
    runtime.answerTimer = null;
  }

  runtime.answerDeadline = null;
}

function transitionToVoting(code) {
  const session = getSession(code);

  if (!session || session.status !== 'answering') {
    return;
  }

  clearAnswerTimer(session.code);
  db.prepare("UPDATE sessions SET status = 'voting' WHERE id = ?").run(session.id);
  io.to(sessionRoom(session.code)).emit('timer:tick', { code: session.code, remaining: 0 });
  emitState(session.code);
}

function scheduleAnswerTimer(code) {
  const session = getSession(code);

  if (!session || session.status !== 'answering') {
    return;
  }

  clearAnswerTimer(session.code);
  const runtime = getRuntime(session.code);
  runtime.answerDeadline = Date.now() + ANSWER_DURATION_SECONDS * 1000;

  io.to(sessionRoom(session.code)).emit('timer:tick', {
    code: session.code,
    remaining: ANSWER_DURATION_SECONDS,
  });
  emitState(session.code);

  runtime.answerTimer = setInterval(() => {
    const remaining = getRemainingSeconds(session.code);
    io.to(sessionRoom(session.code)).emit('timer:tick', { code: session.code, remaining });

    if (remaining <= 0) {
      transitionToVoting(session.code);
    }
  }, 1000);
}

function ensureAnswerTimer(session) {
  const runtime = getRuntime(session.code);

  if (session.status === 'answering' && !runtime.answerTimer) {
    scheduleAnswerTimer(session.code);
    return true;
  }

  return false;
}

const chooseSessionQuestions = db.transaction((sessionId) => {
  const questions = db.prepare(`
    SELECT id
    FROM questions
    ORDER BY RANDOM()
    LIMIT ?
  `).all(QUESTIONS_PER_GAME);

  if (questions.length < QUESTIONS_PER_GAME) {
    throw new Error(`Sunt necesare minimum ${QUESTIONS_PER_GAME} întrebări în baza de date.`);
  }

  db.prepare('DELETE FROM session_questions WHERE session_id = ?').run(sessionId);
  const insert = db.prepare(`
    INSERT INTO session_questions (session_id, question_id, position)
    VALUES (?, ?, ?)
  `);

  questions.forEach((question, position) => insert.run(sessionId, question.id, position));
  db.prepare(`
    UPDATE sessions
    SET status = 'answering', current_question_index = 0
    WHERE id = ?
  `).run(sessionId);
});

function getPlayerForSocket(socket) {
  if (!socket.data.playerId) {
    return null;
  }

  return db.prepare(`
    SELECT
      p.id,
      p.session_id AS sessionId,
      p.name,
      s.code,
      s.status,
      s.current_question_index AS currentQuestionIndex
    FROM players p
    JOIN sessions s ON s.id = p.session_id
    WHERE p.id = ? AND p.socket_id = ?
  `).get(socket.data.playerId, socket.id) || null;
}

function bindHostToSession(socket, session) {
  const runtime = getRuntime(session.code);
  runtime.hostSocketId = socket.id;
  socket.data.hostCode = session.code;
  socket.join(sessionRoom(session.code));
}

function registerSocketHandler(socket, eventName, handler) {
  socket.on(eventName, (payload, acknowledgement) => {
    const reply = typeof acknowledgement === 'function' ? acknowledgement : () => {};

    try {
      handler(payload || {}, reply);
    } catch (error) {
      console.error(`[${eventName}]`, error);
      reply({ ok: false, error: 'A apărut o eroare pe server. Încearcă din nou.' });
    }
  });
}

io.on('connection', (socket) => {
  registerSocketHandler(socket, 'session:create', (_payload, reply) => {
    const oldHostCode = socket.data.hostCode;

    if (oldHostCode) {
      const oldRuntime = getRuntime(oldHostCode);
      if (oldRuntime.hostSocketId === socket.id) {
        oldRuntime.hostSocketId = null;
      }
      socket.leave(sessionRoom(oldHostCode));
    }

    const code = generateSessionCode();
    const result = db.prepare(`
      INSERT INTO sessions (code, status, current_question_index)
      VALUES (?, 'lobby', -1)
    `).run(code);
    const session = getSession(code);

    bindHostToSession(socket, session);
    reply({ ok: true, session: { id: Number(result.lastInsertRowid), code } });
    emitAdminState(code);
  });

  registerSocketHandler(socket, 'host:resume', (payload, reply) => {
    const code = normalizeSessionCode(payload.sessionCode);
    const session = getSession(code);

    if (!session) {
      reply({ ok: false, error: 'Sesiunea nu mai există.' });
      return;
    }

    const runtime = getRuntime(session.code);
    const activeHost = runtime.hostSocketId && io.sockets.sockets.has(runtime.hostSocketId);

    if (activeHost && runtime.hostSocketId !== socket.id) {
      reply({ ok: false, error: 'Sesiunea este deja deschisă într-o altă filă.' });
      return;
    }

    bindHostToSession(socket, session);
    reply({ ok: true, session: { id: session.id, code: session.code } });

    if (!ensureAnswerTimer(session)) {
      emitAdminState(session.code);
    }
  });

  registerSocketHandler(socket, 'game:start', (payload, reply) => {
    const code = normalizeSessionCode(payload.sessionCode);
    const session = getSession(code);
    const runtime = session ? getRuntime(session.code) : null;

    if (!session || runtime.hostSocketId !== socket.id) {
      reply({ ok: false, error: 'Doar hostul sesiunii poate începe jocul.' });
      return;
    }

    if (session.status !== 'lobby') {
      reply({ ok: false, error: 'Jocul a fost deja pornit.' });
      return;
    }

    const questionCount = db.prepare('SELECT COUNT(*) AS count FROM questions').get().count;
    if (questionCount < QUESTIONS_PER_GAME) {
      reply({
        ok: false,
        error: `Adaugă minimum ${QUESTIONS_PER_GAME} întrebări în data/questions.txt și recreează baza de date.`,
      });
      return;
    }

    chooseSessionQuestions(session.id);
    reply({ ok: true });
    scheduleAnswerTimer(session.code);
  });

  registerSocketHandler(socket, 'player:join', (payload, reply) => {
    const code = normalizeSessionCode(payload.sessionCode);
    const name = normalizePlayerName(payload.name);
    const requestedPlayerId = Number.parseInt(payload.playerId, 10) || null;

    if (!/^[A-Z0-9]{4}$/.test(code)) {
      reply({ ok: false, error: 'Codul trebuie să aibă 4 caractere.' });
      return;
    }

    if (!name) {
      reply({ ok: false, error: 'Scrie numele tău ca să poți intra.' });
      return;
    }

    if (name.length > MAX_NAME_LENGTH) {
      reply({ ok: false, error: `Numele poate avea cel mult ${MAX_NAME_LENGTH} de caractere.` });
      return;
    }

    const session = getSession(code);
    if (!session) {
      reply({ ok: false, error: 'Sesiunea nu există. Verifică atent codul.' });
      return;
    }

    const currentPlayer = getPlayerForSocket(socket);
    if (currentPlayer && currentPlayer.sessionId !== session.id) {
      reply({ ok: false, error: 'Ești deja conectat la o altă sesiune.' });
      return;
    }

    let player = null;

    if (requestedPlayerId) {
      player = db.prepare(`
        SELECT id, name, socket_id AS socketId
        FROM players
        WHERE id = ? AND session_id = ?
      `).get(requestedPlayerId, session.id) || null;

      if (player && player.name.toLocaleLowerCase('ro-RO') !== name.toLocaleLowerCase('ro-RO')) {
        player = null;
      }
    }

    if (!player) {
      player = db.prepare(`
        SELECT id, name, socket_id AS socketId
        FROM players
        WHERE session_id = ? AND name = ? COLLATE NOCASE
      `).get(session.id, name) || null;
    }

    if (player?.socketId && player.socketId !== socket.id && io.sockets.sockets.has(player.socketId)) {
      if (requestedPlayerId === player.id) {
        const oldSocket = io.sockets.sockets.get(player.socketId);
        oldSocket?.emit('player:replaced');
        oldSocket?.disconnect(true);
      } else {
        reply({ ok: false, error: 'Numele este deja folosit în această sesiune.' });
        return;
      }
    }

    if (!player) {
      const result = db.prepare(`
        INSERT INTO players (session_id, socket_id, name)
        VALUES (?, ?, ?)
      `).run(session.id, socket.id, name);
      player = { id: Number(result.lastInsertRowid), name, socketId: socket.id };
    } else {
      db.prepare('UPDATE players SET socket_id = ? WHERE id = ?').run(socket.id, player.id);
    }

    socket.data.playerId = player.id;
    socket.data.playerSessionCode = session.code;
    socket.join(sessionRoom(session.code));

    reply({
      ok: true,
      player: { id: player.id, name: player.name },
      session: { code: session.code, status: session.status },
    });

    if (!ensureAnswerTimer(session)) {
      emitAdminState(session.code);
      emitPlayerState(session.code, player.id);
    }
  });

  registerSocketHandler(socket, 'answer:submit', (payload, reply) => {
    const player = getPlayerForSocket(socket);
    const text = normalizeAnswer(payload.text);

    if (!player) {
      reply({ ok: false, error: 'Intră din nou în sesiune.' });
      return;
    }

    const session = getSession(player.code);
    const runtime = getRuntime(session.code);

    if (session.status !== 'answering') {
      reply({ ok: false, error: 'Faza de răspuns s-a încheiat.' });
      return;
    }

    if (runtime.answerDeadline && Date.now() >= runtime.answerDeadline) {
      transitionToVoting(session.code);
      reply({ ok: false, error: 'Timpul pentru răspuns a expirat.' });
      return;
    }

    if (!text) {
      reply({ ok: false, error: 'Răspunsul nu poate fi gol.' });
      return;
    }

    if (text.length > MAX_ANSWER_LENGTH) {
      reply({ ok: false, error: `Răspunsul poate avea cel mult ${MAX_ANSWER_LENGTH} de caractere.` });
      return;
    }

    const question = getCurrentQuestion(session);

    try {
      db.prepare(`
        INSERT INTO answers (session_id, question_id, player_id, text)
        VALUES (?, ?, ?, ?)
      `).run(session.id, question.id, player.id, text);
    } catch (error) {
      if (error.code?.startsWith('SQLITE_CONSTRAINT')) {
        reply({ ok: false, error: 'Ai trimis deja un răspuns la această întrebare.' });
        return;
      }
      throw error;
    }

    reply({ ok: true });
    emitAdminState(session.code);
    emitPlayerState(session.code, player.id);
  });

  registerSocketHandler(socket, 'vote:submit', (payload, reply) => {
    const player = getPlayerForSocket(socket);
    const answerId = Number.parseInt(payload.answerId, 10);

    if (!player) {
      reply({ ok: false, error: 'Intră din nou în sesiune.' });
      return;
    }

    const session = getSession(player.code);
    if (session.status !== 'voting') {
      reply({ ok: false, error: 'Votarea nu este deschisă.' });
      return;
    }

    const question = getCurrentQuestion(session);
    const answer = db.prepare(`
      SELECT id, player_id AS playerId
      FROM answers
      WHERE id = ? AND session_id = ? AND question_id = ?
    `).get(answerId, session.id, question.id);

    if (!answer) {
      reply({ ok: false, error: 'Răspunsul ales nu este valid.' });
      return;
    }

    if (answer.playerId === player.id) {
      reply({ ok: false, error: 'Nu poți vota propriul răspuns.' });
      return;
    }

    try {
      db.prepare(`
        INSERT INTO votes (session_id, question_id, voter_player_id, answer_id)
        VALUES (?, ?, ?, ?)
      `).run(session.id, question.id, player.id, answer.id);
    } catch (error) {
      if (error.code?.startsWith('SQLITE_CONSTRAINT')) {
        reply({ ok: false, error: 'Ai votat deja la această întrebare.' });
        return;
      }
      throw error;
    }

    reply({ ok: true });
    emitAdminState(session.code);
    emitPlayerState(session.code, player.id);
  });

  registerSocketHandler(socket, 'voting:close', (payload, reply) => {
    const code = normalizeSessionCode(payload.sessionCode);
    const session = getSession(code);
    const runtime = session ? getRuntime(session.code) : null;

    if (!session || runtime.hostSocketId !== socket.id) {
      reply({ ok: false, error: 'Doar hostul poate închide votarea.' });
      return;
    }

    if (session.status !== 'voting') {
      reply({ ok: false, error: 'Sesiunea nu este în faza de votare.' });
      return;
    }

    db.prepare("UPDATE sessions SET status = 'question_result' WHERE id = ?").run(session.id);
    reply({ ok: true });
    emitState(session.code);
  });

  registerSocketHandler(socket, 'question:next', (payload, reply) => {
    const code = normalizeSessionCode(payload.sessionCode);
    const session = getSession(code);
    const runtime = session ? getRuntime(session.code) : null;

    if (!session || runtime.hostSocketId !== socket.id) {
      reply({ ok: false, error: 'Doar hostul poate continua jocul.' });
      return;
    }

    if (session.status !== 'question_result') {
      reply({ ok: false, error: 'Rezultatul întrebării nu este încă afișat.' });
      return;
    }

    const totalQuestions = getQuestionCount(session.id);
    const isLastQuestion = session.current_question_index >= totalQuestions - 1;

    if (isLastQuestion) {
      db.prepare("UPDATE sessions SET status = 'finished' WHERE id = ?").run(session.id);
      reply({ ok: true, finished: true });
      emitState(session.code);
      return;
    }

    db.prepare(`
      UPDATE sessions
      SET status = 'answering', current_question_index = current_question_index + 1
      WHERE id = ?
    `).run(session.id);
    reply({ ok: true, finished: false });
    scheduleAnswerTimer(session.code);
  });

  socket.on('disconnect', () => {
    const playerId = socket.data.playerId;
    const playerCode = socket.data.playerSessionCode;

    if (playerId) {
      db.prepare(`
        UPDATE players
        SET socket_id = NULL
        WHERE id = ? AND socket_id = ?
      `).run(playerId, socket.id);
    }

    const hostCode = socket.data.hostCode;
    if (hostCode) {
      const runtime = getRuntime(hostCode);
      if (runtime.hostSocketId === socket.id) {
        runtime.hostSocketId = null;
      }
    }

    if (playerCode) {
      emitAdminState(playerCode);
    }
  });
});

server.listen(PORT, () => {
  console.log(`CrazyQ rulează pe http://localhost:${PORT}`);
  console.log(`Întrebări în SQLite: ${importResult.total} (${importResult.imported} importate acum)`);
});

function shutdown() {
  for (const [code] of runtimeSessions) {
    clearAnswerTimer(code);
  }

  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
