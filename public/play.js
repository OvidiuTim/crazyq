const socket = io();

const elements = {
  miniSession: document.querySelector('#miniSession'),
  connectionMessage: document.querySelector('#connectionMessage'),
  joinView: document.querySelector('#joinView'),
  joinForm: document.querySelector('#joinForm'),
  sessionInput: document.querySelector('#sessionInput'),
  nameInput: document.querySelector('#nameInput'),
  joinButton: document.querySelector('#joinButton'),
  joinMessage: document.querySelector('#joinMessage'),
  gameView: document.querySelector('#gameView'),
  playerPhase: document.querySelector('#playerPhase'),
  playerName: document.querySelector('#playerName'),
  questionNumber: document.querySelector('#playerQuestionNumber'),
  timerBox: document.querySelector('#playerTimerBox'),
  timerValue: document.querySelector('#playerTimerValue'),
  question: document.querySelector('#playerQuestion'),
  phaseContent: document.querySelector('#playerPhaseContent'),
  playerMessage: document.querySelector('#playerMessage'),
};

const statusLabels = {
  lobby: 'Lobby',
  answering: 'Write your answer',
  voting: 'Vote',
  question_result: 'Question result',
  finished: 'Final leaderboard',
};

const querySession = new URLSearchParams(window.location.search).get('session');
let activeSessionCode = querySession?.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || '';
let playerProfile = null;
let currentState = null;
let autoJoinAttempted = false;

function storageKey(code) {
  return `crazyq-player-${code}`;
}

function loadSavedPlayer(code) {
  if (!code) {
    return null;
  }

  try {
    return JSON.parse(localStorage.getItem(storageKey(code))) || null;
  } catch {
    return null;
  }
}

function savePlayer(code, player) {
  localStorage.setItem(storageKey(code), JSON.stringify(player));
}

function setJoining(loading) {
  elements.joinButton.disabled = loading;
  elements.joinButton.textContent = loading ? 'Joining…' : 'Join';
}

function openGame(session, player) {
  activeSessionCode = session.code;
  playerProfile = player;
  savePlayer(session.code, player);
  const url = new URL(window.location.href);
  url.searchParams.set('session', session.code);
  window.history.replaceState({}, '', url);
  elements.joinView.hidden = true;
  elements.gameView.hidden = false;
  elements.miniSession.hidden = false;
  elements.miniSession.textContent = session.code;
  elements.playerName.textContent = player.name;
}

function joinSession({ code, name, playerId = null, silent = false }) {
  if (!silent) {
    elements.joinMessage.textContent = '';
    setJoining(true);
  }

  socket.emit('player:join', { sessionCode: code, name, playerId }, (response) => {
    if (!silent) {
      setJoining(false);
    }

    if (!response?.ok) {
      if (silent) {
        elements.joinView.hidden = false;
        elements.gameView.hidden = true;
        elements.joinMessage.textContent = response?.error || 'The session could not be resumed.';
      } else {
        elements.joinMessage.textContent = response?.error || 'Could not join the session.';
      }
      return;
    }

    openGame(response.session, response.player);
    elements.connectionMessage.hidden = true;
  });
}

function createNotice(title, text, className = '') {
  const notice = document.createElement('div');
  const heading = document.createElement('strong');
  const paragraph = document.createElement('p');
  notice.className = `player-notice ${className}`.trim();
  heading.textContent = title;
  paragraph.textContent = text;
  notice.append(heading, paragraph);
  return notice;
}

function getResultCountdownText(state, remaining) {
  const seconds = `${remaining} ${remaining === 1 ? 'second' : 'seconds'}`;
  return state.question.number === state.question.total
    ? `Final leaderboard starts in ${seconds}…`
    : `Next question starts in ${seconds}…`;
}

function updateResultCountdown(remaining) {
  const countdown = document.querySelector('#resultCountdown');

  if (countdown && currentState) {
    countdown.textContent = getResultCountdownText(currentState, remaining);
  }
}

function renderLobby() {
  elements.questionNumber.textContent = 'Lobby';
  elements.question.textContent = 'You joined the session';
  elements.timerBox.hidden = true;
  elements.phaseContent.append(createNotice(
    "You're in ✓",
    'Keep your phone close. The host will start as soon as the crew is ready.',
    'success-notice',
  ));
}

function renderAnswering(state) {
  elements.timerBox.hidden = false;
  elements.timerValue.textContent = state.timer.remaining;
  elements.timerBox.classList.toggle('is-urgent', state.timer.remaining <= 5);

  if (state.hasAnswered) {
    elements.phaseContent.append(createNotice(
      'Answer submitted ✓',
      'Perfect. Wait and see what everyone else came up with.',
      'success-notice',
    ));
    return;
  }

  const form = document.createElement('form');
  const label = document.createElement('label');
  const textarea = document.createElement('textarea');
  const footer = document.createElement('div');
  const counter = document.createElement('small');
  const button = document.createElement('button');

  form.className = 'answer-form';
  label.htmlFor = 'answerInput';
  label.textContent = 'Your answer';
  textarea.id = 'answerInput';
  textarea.maxLength = 280;
  textarea.rows = 4;
  textarea.placeholder = 'Write something brilliant or completely ridiculous…';
  counter.textContent = '0 / 280';
  button.className = 'button button-primary button-large button-full';
  button.type = 'submit';
  button.textContent = 'Submit answer';

  textarea.addEventListener('input', () => {
    counter.textContent = `${textarea.value.length} / 280`;
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    elements.playerMessage.textContent = '';
    const text = textarea.value.trim();

    if (!text) {
      elements.playerMessage.textContent = 'Your answer cannot be empty.';
      textarea.focus();
      return;
    }

    textarea.disabled = true;
    button.disabled = true;
    button.textContent = 'Submitting…';
    socket.emit('answer:submit', {
      text,
      questionId: currentState?.question?.id,
    }, (response) => {
      if (!response?.ok) {
        textarea.disabled = false;
        button.disabled = false;
        button.textContent = 'Submit answer';
        elements.playerMessage.textContent = response?.error || 'Your answer could not be submitted.';
      }
    });
  });

  footer.className = 'answer-footer';
  footer.append(counter);
  form.append(label, textarea, footer, button);
  elements.phaseContent.append(form);
  window.setTimeout(() => textarea.focus(), 0);
}

function submitVote(answerId, button, isOwn) {
  elements.playerMessage.textContent = '';

  if (isOwn) {
    elements.playerMessage.textContent = "You can't vote for your own answer. At least you tried.";
    return;
  }

  const buttons = elements.phaseContent.querySelectorAll('.vote-option');
  buttons.forEach((option) => { option.disabled = true; });
  button.classList.add('is-selected');

  socket.emit('vote:submit', { answerId }, (response) => {
    if (!response?.ok) {
      buttons.forEach((option) => { option.disabled = false; });
      button.classList.remove('is-selected');
      elements.playerMessage.textContent = response?.error || 'Your vote could not be submitted.';
    }
  });
}

function renderVoting(state) {
  elements.timerBox.hidden = true;

  if (state.hasVoted) {
    elements.phaseContent.append(createNotice(
      'Vote submitted ✓',
      'Your vote is in. The host will reveal the result.',
      'success-notice',
    ));
    return;
  }

  const intro = document.createElement('p');
  const list = document.createElement('div');
  intro.className = 'vote-intro';
  intro.textContent = 'Pick your favorite answer. Your own answer is off-limits.';
  list.className = 'vote-list';

  if (!state.answers?.length) {
    elements.phaseContent.append(createNotice('No answers', 'This round was suspiciously quiet.'));
    return;
  }

  state.answers.forEach((answer, index) => {
    const button = document.createElement('button');
    const number = document.createElement('span');
    const text = document.createElement('span');
    const own = document.createElement('small');

    button.className = `vote-option${answer.isOwn ? ' is-own' : ''}`;
    button.type = 'button';
    number.className = 'vote-number';
    number.textContent = `${index + 1}`;
    text.textContent = answer.text;
    button.append(number, text);

    if (answer.isOwn) {
      own.textContent = 'your answer';
      button.append(own);
    }

    button.addEventListener('click', () => submitVote(answer.id, button, answer.isOwn));
    list.append(button);
  });

  elements.phaseContent.append(intro, list);
}

function renderResults(state) {
  elements.timerBox.hidden = true;
  const list = document.createElement('div');
  const heading = document.createElement('h2');
  const countdown = document.createElement('p');
  const favorites = state.favorites || [];
  list.className = 'results-list mobile-results';
  heading.className = 'content-title';
  heading.textContent = favorites.length > 1 ? 'Favorite answers' : 'Favorite answer';
  countdown.id = 'resultCountdown';
  countdown.className = 'result-countdown';
  countdown.textContent = getResultCountdownText(state, state.timer.remaining);

  if (!favorites.length) {
    elements.phaseContent.append(
      heading,
      createNotice('No favorite answer', 'No one answered this round.'),
      countdown,
    );
    return;
  }

  favorites.forEach((result) => {
    const item = document.createElement('article');
    const rank = document.createElement('span');
    const body = document.createElement('div');
    const text = document.createElement('p');
    const author = document.createElement('small');
    const votes = document.createElement('strong');

    item.className = 'result-item';
    rank.className = 'result-rank';
    rank.textContent = '★';
    text.textContent = result.text;
    author.textContent = result.authorName;
    votes.className = 'vote-count';
    votes.textContent = `${result.voteCount} ${result.voteCount === 1 ? 'vote' : 'votes'}`;
    body.append(text, author);
    item.append(rank, body, votes);
    list.append(item);
  });

  elements.phaseContent.append(heading, list, countdown);
}

function createLeaderboard(leaderboard) {
  const wrapper = document.createElement('div');
  const trophy = document.createElement('div');
  const podium = document.createElement('div');
  const rest = document.createElement('div');

  wrapper.className = 'leaderboard mobile-leaderboard';
  trophy.className = 'mobile-trophy';
  trophy.textContent = '🏆';
  podium.className = 'podium mobile-podium';
  rest.className = 'ranking-list';

  leaderboard.slice(0, 3).forEach((player, index) => {
    const card = document.createElement('article');
    const place = document.createElement('span');
    const name = document.createElement('strong');
    const score = document.createElement('span');
    card.className = `podium-card place-${index + 1}`;
    place.className = 'podium-place';
    place.textContent = `${index + 1}`;
    name.textContent = player.name;
    score.textContent = `${player.score} pts`;
    card.append(place, name, score);
    podium.append(card);
  });

  leaderboard.slice(3).forEach((player) => {
    const row = document.createElement('div');
    const rank = document.createElement('span');
    const name = document.createElement('strong');
    const score = document.createElement('span');
    rank.textContent = `${player.rank}`;
    name.textContent = player.name;
    score.textContent = `${player.score} pts`;
    row.append(rank, name, score);
    rest.append(row);
  });

  wrapper.append(trophy, podium, rest);
  return wrapper;
}

function renderState(state) {
  currentState = state;
  elements.playerMessage.textContent = '';
  elements.playerPhase.textContent = statusLabels[state.session.status];
  elements.phaseContent.replaceChildren();

  if (state.session.status === 'lobby') {
    renderLobby();
    return;
  }

  if (state.session.status === 'finished') {
    elements.questionNumber.textContent = 'Game over';
    elements.question.textContent = 'Final leaderboard';
    elements.timerBox.hidden = true;
    elements.phaseContent.append(createLeaderboard(state.leaderboard || []));
    return;
  }

  elements.questionNumber.textContent = `Question ${state.question.number} / ${state.question.total}`;
  elements.question.textContent = state.question.text;

  if (state.session.status === 'answering') {
    renderAnswering(state);
  } else if (state.session.status === 'voting') {
    renderVoting(state);
  } else if (state.session.status === 'question_result') {
    renderResults(state);
  }
}

function attemptAutoJoin() {
  if (autoJoinAttempted || !socket.connected || !activeSessionCode) {
    return;
  }

  autoJoinAttempted = true;
  const saved = loadSavedPlayer(activeSessionCode);

  if (saved?.id && saved?.name) {
    elements.connectionMessage.hidden = false;
    elements.connectionMessage.textContent = 'Rejoining the session…';
    joinSession({ code: activeSessionCode, name: saved.name, playerId: saved.id, silent: true });
  }
}

elements.joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const code = elements.sessionInput.value.trim().toUpperCase();
  const name = elements.nameInput.value.trim();

  if (code.length !== 4) {
    elements.joinMessage.textContent = 'The code must be 4 characters long.';
    elements.sessionInput.focus();
    return;
  }

  if (!name) {
    elements.joinMessage.textContent = 'Enter your name to join.';
    elements.nameInput.focus();
    return;
  }

  const saved = loadSavedPlayer(code);
  joinSession({ code, name, playerId: saved?.name === name ? saved.id : null });
});

elements.sessionInput.addEventListener('input', () => {
  elements.sessionInput.value = elements.sessionInput.value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 4);
});

socket.on('game:state', renderState);

socket.on('timer:tick', ({ code, remaining, phase }) => {
  if (code !== activeSessionCode) {
    return;
  }

  if (phase === 'question_result' && currentState?.session.status === 'question_result') {
    updateResultCountdown(remaining);
    return;
  }

  if (phase !== 'answering' || currentState?.session.status !== 'answering') {
    return;
  }

  elements.timerValue.textContent = remaining;
  elements.timerBox.classList.toggle('is-urgent', remaining <= 5);

  if (remaining <= 0) {
    const input = document.querySelector('#answerInput');
    const button = elements.phaseContent.querySelector('button[type="submit"]');
    if (input) input.disabled = true;
    if (button) button.disabled = true;
    elements.playerMessage.textContent = "Time's up. Getting voting ready…";
  }
});

socket.on('player:replaced', () => {
  elements.connectionMessage.hidden = false;
  elements.connectionMessage.textContent = 'This session was opened in another tab.';
});

socket.on('connect', () => {
  elements.connectionMessage.hidden = true;

  if (playerProfile) {
    joinSession({
      code: activeSessionCode,
      name: playerProfile.name,
      playerId: playerProfile.id,
      silent: true,
    });
  } else {
    attemptAutoJoin();
  }
});

socket.on('disconnect', (reason) => {
  elements.connectionMessage.hidden = false;
  elements.connectionMessage.textContent = reason === 'io server disconnect'
    ? 'This session is active in another tab.'
    : 'Connection lost. Trying again…';
});

if (activeSessionCode) {
  elements.sessionInput.value = activeSessionCode;
  const saved = loadSavedPlayer(activeSessionCode);
  if (saved?.name) {
    elements.nameInput.value = saved.name;
  } else {
    elements.nameInput.focus();
  }
}
