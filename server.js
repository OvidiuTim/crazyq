const path = require('node:path');
const http = require('node:http');

const express = require('express');
const { Server } = require('socket.io');

const { db, importResult } = require('./database');

const app = express();
// Nginx este singurul proxy din fața aplicației în configurația recomandată.
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['polling', 'websocket'],
  allowUpgrades: true,
});

const PORT = process.env.PORT || 3000;
const ANSWER_DURATION_SECONDS = Math.max(
  1,
  Number.parseInt(process.env.ANSWER_DURATION_SECONDS, 10) || 17,
);
const VOTING_DURATION_SECONDS = Math.max(
  1,
  Number.parseInt(process.env.VOTING_DURATION_SECONDS, 10) || 15,
);
const RESULT_DURATION_SECONDS = Math.max(
  1,
  Number.parseInt(process.env.RESULT_DURATION_SECONDS, 10) || 5,
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
      votingDeadline: null,
      votingTimer: null,
      resultDeadline: null,
      resultTimer: null,
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

  throw new Error('Could not generate a unique session code.');
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

function getAnsweredPlayerIds(sessionId, questionId) {
  if (!questionId) {
    return new Set();
  }

  return new Set(db.prepare(`
    SELECT player_id AS playerId
    FROM answers
    WHERE session_id = ? AND question_id = ?
  `).all(sessionId, questionId).map((answer) => answer.playerId));
}

function getVoterPlayerIds(sessionId, questionId) {
  if (!questionId) {
    return new Set();
  }

  return new Set(db.prepare(`
    SELECT voter_player_id AS playerId
    FROM votes
    WHERE session_id = ? AND question_id = ?
  `).all(sessionId, questionId).map((vote) => vote.playerId));
}

function haveAllActivePlayersAnswered(session, questionId) {
  if (!session || session.status !== 'answering' || !questionId) {
    return false;
  }

  const activePlayers = getSessionPlayers(session.id).filter((player) => player.connected);

  if (activePlayers.length === 0) {
    return false;
  }

  const answeredPlayerIds = getAnsweredPlayerIds(session.id, questionId);
  return activePlayers.every((player) => answeredPlayerIds.has(player.id));
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

function getEligibleVoterIds(session, questionId) {
  if (!session || !questionId) {
    return [];
  }

  const answers = getVotingAnswers(session.id, questionId);

  if (answers.length === 0) {
    return [];
  }

  return getSessionPlayers(session.id)
    .filter((player) => player.connected)
    .filter((player) => answers.some((answer) => answer.playerId !== player.id))
    .map((player) => player.id);
}

function haveAllEligiblePlayersVoted(session, questionId) {
  if (!session || session.status !== 'voting' || !questionId) {
    return false;
  }

  const eligibleVoterIds = getEligibleVoterIds(session, questionId);

  if (eligibleVoterIds.length === 0) {
    return true;
  }

  const voterPlayerIds = getVoterPlayerIds(session.id, questionId);
  return eligibleVoterIds.every((playerId) => voterPlayerIds.has(playerId));
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

function getFavoriteResults(sessionId, questionId) {
  const results = getQuestionResults(sessionId, questionId);

  if (results.length === 0) {
    return [];
  }

  const highestVoteCount = results[0].voteCount;
  return results.filter((result) => result.voteCount === highestVoteCount);
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

function getPhaseDeadline(runtime, status) {
  if (status === 'answering') return runtime.answerDeadline;
  if (status === 'voting') return runtime.votingDeadline;
  if (status === 'question_result') return runtime.resultDeadline;
  return null;
}

function getRemainingSeconds(code, status) {
  const deadline = getPhaseDeadline(getRuntime(code), status);
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
      remaining: getRemainingSeconds(session.code, session.status),
      deadline: getPhaseDeadline(getRuntime(session.code), session.status),
    },
  };
}

function buildAdminState(session) {
  const base = buildBaseState(session);
  const players = getSessionPlayers(session.id);
  const activePlayers = players.filter((player) => player.connected);
  const questionId = base.question?.id;
  const answeredPlayerIds = getAnsweredPlayerIds(session.id, questionId);
  const voterPlayerIds = getVoterPlayerIds(session.id, questionId);
  const eligibleVoterIds = getEligibleVoterIds(session, questionId);
  const state = {
    ...base,
    players,
    progress: {
      playersTotal: activePlayers.length,
      playersRegistered: players.length,
      playersConnected: activePlayers.length,
      answersSubmitted: activePlayers.filter((player) => answeredPlayerIds.has(player.id)).length,
      eligibleVoters: eligibleVoterIds.length,
      votesSubmitted: eligibleVoterIds.filter((playerId) => voterPlayerIds.has(playerId)).length,
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
    state.favorites = getFavoriteResults(session.id, questionId);
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
    state.favorites = getFavoriteResults(session.id, questionId);
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

function clearVotingTimer(code) {
  const runtime = getRuntime(code);

  if (runtime.votingTimer) {
    clearInterval(runtime.votingTimer);
    runtime.votingTimer = null;
  }

  runtime.votingDeadline = null;
}

function clearResultTimer(code) {
  const runtime = getRuntime(code);

  if (runtime.resultTimer) {
    clearInterval(runtime.resultTimer);
    runtime.resultTimer = null;
  }

  runtime.resultDeadline = null;
}

function clearSessionTimers(code) {
  clearAnswerTimer(code);
  clearVotingTimer(code);
  clearResultTimer(code);
}

function scheduleAnswerTimer(code) {
  const session = getSession(code);

  if (!session || session.status !== 'answering') {
    return;
  }

  clearSessionTimers(session.code);
  const runtime = getRuntime(session.code);
  runtime.answerDeadline = Date.now() + ANSWER_DURATION_SECONDS * 1000;
  const expectedQuestionIndex = session.current_question_index;

  io.to(sessionRoom(session.code)).emit('timer:tick', {
    code: session.code,
    remaining: ANSWER_DURATION_SECONDS,
    phase: 'answering',
  });
  emitState(session.code);

  runtime.answerTimer = setInterval(() => {
    const currentSession = getSession(session.code);

    if (!currentSession
      || currentSession.status !== 'answering'
      || currentSession.current_question_index !== expectedQuestionIndex) {
      clearAnswerTimer(session.code);
      return;
    }

    const remaining = getRemainingSeconds(session.code, 'answering');
    io.to(sessionRoom(session.code)).emit('timer:tick', {
      code: session.code,
      remaining,
      phase: 'answering',
    });

    if (remaining <= 0) {
      transitionToVoting(session.code);
    }
  }, 1000);
}

function transitionToVoting(code) {
  const session = getSession(code);

  if (!session || session.status !== 'answering') {
    return false;
  }

  clearAnswerTimer(session.code);
  io.to(sessionRoom(session.code)).emit('timer:tick', {
    code: session.code,
    remaining: 0,
    phase: 'answering',
  });
  db.prepare("UPDATE sessions SET status = 'voting' WHERE id = ?").run(session.id);
  scheduleVotingTimer(session.code);
  return true;
}

function scheduleVotingTimer(code) {
  const session = getSession(code);

  if (!session || session.status !== 'voting') {
    return;
  }

  clearVotingTimer(session.code);
  clearResultTimer(session.code);
  const runtime = getRuntime(session.code);
  runtime.votingDeadline = Date.now() + VOTING_DURATION_SECONDS * 1000;
  const expectedQuestionIndex = session.current_question_index;

  io.to(sessionRoom(session.code)).emit('timer:tick', {
    code: session.code,
    remaining: VOTING_DURATION_SECONDS,
    phase: 'voting',
  });
  emitState(session.code);

  const question = getCurrentQuestion(session);
  if (haveAllEligiblePlayersVoted(session, question?.id)) {
    transitionToQuestionResult(session.code);
    return;
  }

  runtime.votingTimer = setInterval(() => {
    const currentSession = getSession(session.code);

    if (!currentSession
      || currentSession.status !== 'voting'
      || currentSession.current_question_index !== expectedQuestionIndex) {
      clearVotingTimer(session.code);
      return;
    }

    const remaining = getRemainingSeconds(session.code, 'voting');
    io.to(sessionRoom(session.code)).emit('timer:tick', {
      code: session.code,
      remaining,
      phase: 'voting',
    });

    if (remaining <= 0) {
      transitionToQuestionResult(session.code);
    }
  }, 1000);
}

function transitionToQuestionResult(code) {
  const session = getSession(code);

  if (!session || session.status !== 'voting') {
    return false;
  }

  clearVotingTimer(session.code);
  io.to(sessionRoom(session.code)).emit('timer:tick', {
    code: session.code,
    remaining: 0,
    phase: 'voting',
  });
  db.prepare("UPDATE sessions SET status = 'question_result' WHERE id = ?").run(session.id);
  scheduleResultTimer(session.code);
  return true;
}

function scheduleResultTimer(code) {
  const session = getSession(code);

  if (!session || session.status !== 'question_result') {
    return;
  }

  clearResultTimer(session.code);
  const runtime = getRuntime(session.code);
  runtime.resultDeadline = Date.now() + RESULT_DURATION_SECONDS * 1000;
  const expectedQuestionIndex = session.current_question_index;

  io.to(sessionRoom(session.code)).emit('timer:tick', {
    code: session.code,
    remaining: RESULT_DURATION_SECONDS,
    phase: 'question_result',
  });
  emitState(session.code);

  runtime.resultTimer = setInterval(() => {
    const currentSession = getSession(session.code);

    if (!currentSession
      || currentSession.status !== 'question_result'
      || currentSession.current_question_index !== expectedQuestionIndex) {
      clearResultTimer(session.code);
      return;
    }

    const remaining = getRemainingSeconds(session.code, 'question_result');
    io.to(sessionRoom(session.code)).emit('timer:tick', {
      code: session.code,
      remaining,
      phase: 'question_result',
    });

    if (remaining <= 0) {
      advanceFromQuestionResult(session.code, expectedQuestionIndex);
    }
  }, 1000);
}

function advanceFromQuestionResult(code, expectedQuestionIndex = null) {
  const session = getSession(code);

  if (!session
    || session.status !== 'question_result'
    || (expectedQuestionIndex !== null
      && session.current_question_index !== expectedQuestionIndex)) {
    return null;
  }

  clearResultTimer(session.code);
  io.to(sessionRoom(session.code)).emit('timer:tick', {
    code: session.code,
    remaining: 0,
    phase: 'question_result',
  });

  const totalQuestions = getQuestionCount(session.id);
  const isLastQuestion = session.current_question_index >= totalQuestions - 1;

  if (isLastQuestion) {
    db.prepare("UPDATE sessions SET status = 'finished' WHERE id = ?").run(session.id);
    emitState(session.code);
    return { finished: true };
  }

  db.prepare(`
    UPDATE sessions
    SET status = 'answering', current_question_index = current_question_index + 1
    WHERE id = ?
  `).run(session.id);
  scheduleAnswerTimer(session.code);
  return { finished: false };
}

function ensurePhaseTimer(session) {
  const runtime = getRuntime(session.code);

  if (session.status === 'answering' && !runtime.answerTimer) {
    scheduleAnswerTimer(session.code);
    return true;
  }

  if (session.status === 'voting' && !runtime.votingTimer) {
    scheduleVotingTimer(session.code);
    return true;
  }

  if (session.status === 'question_result' && !runtime.resultTimer) {
    scheduleResultTimer(session.code);
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
    throw new Error(`The database needs at least ${QUESTIONS_PER_GAME} questions.`);
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
      reply({ ok: false, error: 'Something went wrong on the server. Please try again.' });
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
      reply({ ok: false, error: 'This session no longer exists.' });
      return;
    }

    const runtime = getRuntime(session.code);
    const activeHost = runtime.hostSocketId && io.sockets.sockets.has(runtime.hostSocketId);

    if (activeHost && runtime.hostSocketId !== socket.id) {
      reply({ ok: false, error: 'This session is already open in another tab.' });
      return;
    }

    bindHostToSession(socket, session);
    reply({ ok: true, session: { id: session.id, code: session.code } });

    if (!ensurePhaseTimer(session)) {
      emitAdminState(session.code);
    }
  });

  registerSocketHandler(socket, 'game:start', (payload, reply) => {
    const code = normalizeSessionCode(payload.sessionCode);
    const session = getSession(code);
    const runtime = session ? getRuntime(session.code) : null;

    if (!session || runtime.hostSocketId !== socket.id) {
      reply({ ok: false, error: 'Only the session host can start the game.' });
      return;
    }

    if (session.status !== 'lobby') {
      reply({ ok: false, error: 'The game has already started.' });
      return;
    }

    const questionCount = db.prepare('SELECT COUNT(*) AS count FROM questions').get().count;
    if (questionCount < QUESTIONS_PER_GAME) {
      reply({
        ok: false,
        error: `Add at least ${QUESTIONS_PER_GAME} questions to data/questions.txt and recreate the database.`,
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
      reply({ ok: false, error: 'The code must be 4 characters long.' });
      return;
    }

    if (!name) {
      reply({ ok: false, error: 'Enter your name to join.' });
      return;
    }

    if (name.length > MAX_NAME_LENGTH) {
      reply({ ok: false, error: `Your name can be up to ${MAX_NAME_LENGTH} characters long.` });
      return;
    }

    const session = getSession(code);
    if (!session) {
      reply({ ok: false, error: 'That session does not exist. Double-check the code.' });
      return;
    }

    const currentPlayer = getPlayerForSocket(socket);
    if (currentPlayer && currentPlayer.sessionId !== session.id) {
      reply({ ok: false, error: 'You are already connected to another session.' });
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
        reply({ ok: false, error: 'That name is already taken in this session.' });
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

    const currentQuestion = getCurrentQuestion(session);

    if (haveAllActivePlayersAnswered(session, currentQuestion?.id)) {
      transitionToVoting(session.code);
    } else if (haveAllEligiblePlayersVoted(session, currentQuestion?.id)) {
      transitionToQuestionResult(session.code);
    } else if (!ensurePhaseTimer(session)) {
      emitAdminState(session.code);
      emitPlayerState(session.code, player.id);
    }
  });

  registerSocketHandler(socket, 'answer:submit', (payload, reply) => {
    const player = getPlayerForSocket(socket);
    const text = normalizeAnswer(payload.text);

    if (!player) {
      reply({ ok: false, error: 'Please rejoin the session.' });
      return;
    }

    const session = getSession(player.code);
    const runtime = getRuntime(session.code);

    if (session.status !== 'answering') {
      reply({ ok: false, error: 'The answering phase has ended.' });
      return;
    }

    if (runtime.answerDeadline && Date.now() >= runtime.answerDeadline) {
      transitionToVoting(session.code);
      reply({ ok: false, error: 'Time is up for this answer.' });
      return;
    }

    if (!text) {
      reply({ ok: false, error: 'Your answer cannot be empty.' });
      return;
    }

    if (text.length > MAX_ANSWER_LENGTH) {
      reply({ ok: false, error: `Your answer can be up to ${MAX_ANSWER_LENGTH} characters long.` });
      return;
    }

    const question = getCurrentQuestion(session);
    const submittedQuestionId = Number.parseInt(payload.questionId, 10);

    if (submittedQuestionId && submittedQuestionId !== question?.id) {
      reply({ ok: false, error: 'This question is no longer accepting answers.' });
      return;
    }

    try {
      db.prepare(`
        INSERT INTO answers (session_id, question_id, player_id, text)
        VALUES (?, ?, ?, ?)
      `).run(session.id, question.id, player.id, text);
    } catch (error) {
      if (error.code?.startsWith('SQLITE_CONSTRAINT')) {
        reply({ ok: false, error: 'You already submitted an answer to this question.' });
        return;
      }
      throw error;
    }

    reply({ ok: true });

    if (haveAllActivePlayersAnswered(session, question.id)) {
      transitionToVoting(session.code);
    } else {
      emitAdminState(session.code);
      emitPlayerState(session.code, player.id);
    }
  });

  registerSocketHandler(socket, 'vote:submit', (payload, reply) => {
    const player = getPlayerForSocket(socket);
    const answerId = Number.parseInt(payload.answerId, 10);

    if (!player) {
      reply({ ok: false, error: 'Please rejoin the session.' });
      return;
    }

    const session = getSession(player.code);
    if (session.status !== 'voting') {
      reply({ ok: false, error: 'Voting is not open.' });
      return;
    }

    const runtime = getRuntime(session.code);
    if (runtime.votingDeadline && Date.now() >= runtime.votingDeadline) {
      transitionToQuestionResult(session.code);
      reply({ ok: false, error: 'Voting has ended.' });
      return;
    }

    const question = getCurrentQuestion(session);
    const answer = db.prepare(`
      SELECT id, player_id AS playerId
      FROM answers
      WHERE id = ? AND session_id = ? AND question_id = ?
    `).get(answerId, session.id, question.id);

    if (!answer) {
      reply({ ok: false, error: 'The selected answer is not valid.' });
      return;
    }

    if (answer.playerId === player.id) {
      reply({ ok: false, error: 'You cannot vote for your own answer.' });
      return;
    }

    try {
      db.prepare(`
        INSERT INTO votes (session_id, question_id, voter_player_id, answer_id)
        VALUES (?, ?, ?, ?)
      `).run(session.id, question.id, player.id, answer.id);
    } catch (error) {
      if (error.code?.startsWith('SQLITE_CONSTRAINT')) {
        reply({ ok: false, error: 'You already voted on this question.' });
        return;
      }
      throw error;
    }

    reply({ ok: true });

    if (haveAllEligiblePlayersVoted(session, question.id)) {
      transitionToQuestionResult(session.code);
    } else {
      emitAdminState(session.code);
      emitPlayerState(session.code, player.id);
    }
  });

  registerSocketHandler(socket, 'voting:close', (payload, reply) => {
    const code = normalizeSessionCode(payload.sessionCode);
    const session = getSession(code);
    const runtime = session ? getRuntime(session.code) : null;
    const expectedQuestionIndex = Number.parseInt(payload.questionIndex, 10);

    if (!session || runtime.hostSocketId !== socket.id) {
      reply({ ok: false, error: 'Only the host can close voting.' });
      return;
    }

    if (Number.isInteger(expectedQuestionIndex)
      && expectedQuestionIndex !== session.current_question_index) {
      reply({ ok: true, alreadyAdvanced: true });
      return;
    }

    if (session.status !== 'voting') {
      if (['question_result', 'answering', 'finished'].includes(session.status)) {
        reply({ ok: true, alreadyAdvanced: true });
        return;
      }
      reply({ ok: false, error: 'The session is not in the voting phase.' });
      return;
    }

    reply({ ok: true });
    transitionToQuestionResult(session.code);
  });

  registerSocketHandler(socket, 'question:next', (payload, reply) => {
    const code = normalizeSessionCode(payload.sessionCode);
    const session = getSession(code);
    const runtime = session ? getRuntime(session.code) : null;
    const expectedQuestionIndex = Number.parseInt(payload.questionIndex, 10);

    if (!session || runtime.hostSocketId !== socket.id) {
      reply({ ok: false, error: 'Only the host can continue the game.' });
      return;
    }

    if (Number.isInteger(expectedQuestionIndex)
      && expectedQuestionIndex !== session.current_question_index) {
      reply({ ok: true, alreadyAdvanced: true });
      return;
    }

    if (session.status !== 'question_result') {
      if (['answering', 'voting', 'finished'].includes(session.status)) {
        reply({ ok: true, alreadyAdvanced: true, finished: session.status === 'finished' });
        return;
      }
      reply({ ok: false, error: 'The question result is not being shown yet.' });
      return;
    }

    const result = advanceFromQuestionResult(session.code, session.current_question_index);
    reply({ ok: true, finished: result.finished });
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
      const session = getSession(playerCode);
      const question = getCurrentQuestion(session);

      if (haveAllActivePlayersAnswered(session, question?.id)) {
        transitionToVoting(session.code);
      } else if (haveAllEligiblePlayersVoted(session, question?.id)) {
        transitionToQuestionResult(session.code);
      } else {
        emitAdminState(playerCode);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`CrazyQ is running at http://localhost:${PORT}`);
  console.log(`Questions in SQLite: ${importResult.total} (${importResult.imported} imported now)`);
});

function shutdown() {
  for (const [code] of runtimeSessions) {
    clearSessionTimers(code);
  }

  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
