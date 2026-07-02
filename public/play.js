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
  answering: 'Scrie răspunsul',
  voting: 'Votează',
  question_result: 'Rezultat',
  finished: 'Clasament final',
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
  elements.joinButton.textContent = loading ? 'Intrăm…' : 'Join';
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
        elements.joinMessage.textContent = response?.error || 'Nu am putut relua sesiunea.';
      } else {
        elements.joinMessage.textContent = response?.error || 'Nu am putut intra în sesiune.';
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

function renderLobby() {
  elements.questionNumber.textContent = 'Lobby';
  elements.question.textContent = 'Ai intrat în sesiune';
  elements.timerBox.hidden = true;
  elements.phaseContent.append(createNotice(
    'Ești înăuntru ✓',
    'Ține telefonul aproape. Hostul pornește jocul imediat ce se strânge gașca.',
    'success-notice',
  ));
}

function renderAnswering(state) {
  elements.timerBox.hidden = false;
  elements.timerValue.textContent = state.timer.remaining;

  if (state.hasAnswered) {
    elements.phaseContent.append(createNotice(
      'Răspuns trimis ✓',
      'Perfect. Așteaptă să vedem ce au inventat ceilalți.',
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
  label.textContent = 'Răspunsul tău';
  textarea.id = 'answerInput';
  textarea.maxLength = 280;
  textarea.rows = 4;
  textarea.placeholder = 'Scrie ceva genial sau complet absurd…';
  counter.textContent = '0 / 280';
  button.className = 'button button-primary button-large button-full';
  button.type = 'submit';
  button.textContent = 'Trimite răspunsul';

  textarea.addEventListener('input', () => {
    counter.textContent = `${textarea.value.length} / 280`;
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    elements.playerMessage.textContent = '';
    const text = textarea.value.trim();

    if (!text) {
      elements.playerMessage.textContent = 'Răspunsul nu poate fi gol.';
      textarea.focus();
      return;
    }

    textarea.disabled = true;
    button.disabled = true;
    button.textContent = 'Se trimite…';
    socket.emit('answer:submit', { text }, (response) => {
      if (!response?.ok) {
        textarea.disabled = false;
        button.disabled = false;
        button.textContent = 'Trimite răspunsul';
        elements.playerMessage.textContent = response?.error || 'Răspunsul nu a putut fi trimis.';
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
    elements.playerMessage.textContent = 'Nu poți vota propriul răspuns. Măcar ai încercat.';
    return;
  }

  const buttons = elements.phaseContent.querySelectorAll('.vote-option');
  buttons.forEach((option) => { option.disabled = true; });
  button.classList.add('is-selected');

  socket.emit('vote:submit', { answerId }, (response) => {
    if (!response?.ok) {
      buttons.forEach((option) => { option.disabled = false; });
      button.classList.remove('is-selected');
      elements.playerMessage.textContent = response?.error || 'Votul nu a putut fi trimis.';
    }
  });
}

function renderVoting(state) {
  elements.timerBox.hidden = true;

  if (state.hasVoted) {
    elements.phaseContent.append(createNotice(
      'Vot trimis ✓',
      'Alegerea ta e înregistrată. Hostul va dezvălui rezultatul.',
      'success-notice',
    ));
    return;
  }

  const intro = document.createElement('p');
  const list = document.createElement('div');
  intro.className = 'vote-intro';
  intro.textContent = 'Alege răspunsul tău preferat. Al tău rămâne în afara competiției.';
  list.className = 'vote-list';

  if (!state.answers?.length) {
    elements.phaseContent.append(createNotice('Niciun răspuns', 'Runda aceasta a fost suspect de liniștită.'));
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
      own.textContent = 'răspunsul tău';
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
  list.className = 'results-list mobile-results';

  if (!state.results?.length) {
    elements.phaseContent.append(createNotice('Fără rezultate', 'Nimeni nu a răspuns în această rundă.'));
    return;
  }

  state.results.forEach((result, index) => {
    const item = document.createElement('article');
    const rank = document.createElement('span');
    const body = document.createElement('div');
    const text = document.createElement('p');
    const author = document.createElement('small');
    const votes = document.createElement('strong');

    item.className = 'result-item';
    rank.className = 'result-rank';
    rank.textContent = `${index + 1}`;
    text.textContent = result.text;
    author.textContent = result.authorName;
    votes.className = 'vote-count';
    votes.textContent = `${result.voteCount}p`;
    body.append(text, author);
    item.append(rank, body, votes);
    list.append(item);
  });

  elements.phaseContent.append(list, createNotice('Runda s-a încheiat', 'Hostul pregătește următoarea întrebare.'));
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
    score.textContent = `${player.score} p`;
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
    score.textContent = `${player.score} p`;
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
    elements.questionNumber.textContent = 'Joc încheiat';
    elements.question.textContent = 'Clasamentul final';
    elements.timerBox.hidden = true;
    elements.phaseContent.append(createLeaderboard(state.leaderboard || []));
    return;
  }

  elements.questionNumber.textContent = `Întrebarea ${state.question.number} / ${state.question.total}`;
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
    elements.connectionMessage.textContent = 'Reintrăm în sesiune…';
    joinSession({ code: activeSessionCode, name: saved.name, playerId: saved.id, silent: true });
  }
}

elements.joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const code = elements.sessionInput.value.trim().toUpperCase();
  const name = elements.nameInput.value.trim();

  if (code.length !== 4) {
    elements.joinMessage.textContent = 'Codul trebuie să aibă 4 caractere.';
    elements.sessionInput.focus();
    return;
  }

  if (!name) {
    elements.joinMessage.textContent = 'Scrie numele tău ca să poți intra.';
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

socket.on('timer:tick', ({ code, remaining }) => {
  if (code !== activeSessionCode || currentState?.session.status !== 'answering') {
    return;
  }

  elements.timerValue.textContent = remaining;
  elements.timerBox.classList.toggle('is-urgent', remaining <= 5);

  if (remaining <= 0) {
    const input = document.querySelector('#answerInput');
    const button = elements.phaseContent.querySelector('button[type="submit"]');
    if (input) input.disabled = true;
    if (button) button.disabled = true;
    elements.playerMessage.textContent = 'Timpul a expirat. Pregătim votarea…';
  }
});

socket.on('player:replaced', () => {
  elements.connectionMessage.hidden = false;
  elements.connectionMessage.textContent = 'Sesiunea a fost deschisă într-o altă filă.';
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
    ? 'Sesiunea este activă într-o altă filă.'
    : 'Conexiune întreruptă. Încercăm din nou…';
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
