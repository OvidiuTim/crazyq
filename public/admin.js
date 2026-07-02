const socket = io();
const HOST_STORAGE_KEY = 'crazyq-host-session';

const elements = {
  createView: document.querySelector('#createView'),
  createButton: document.querySelector('#createSessionButton'),
  createMessage: document.querySelector('#createMessage'),
  sessionView: document.querySelector('#sessionView'),
  sessionCode: document.querySelector('#sessionCode'),
  lobbyCode: document.querySelector('#lobbyCode'),
  playerLink: document.querySelector('#playerLink'),
  copyButton: document.querySelector('#copyLinkButton'),
  copyMessage: document.querySelector('#copyMessage'),
  startButton: document.querySelector('#startGameButton'),
  startMessage: document.querySelector('#startMessage'),
  newSessionButton: document.querySelector('#newSessionButton'),
  headerStatus: document.querySelector('#headerStatus'),
  connectionMessage: document.querySelector('#connectionMessage'),
  questionCounter: document.querySelector('#questionCounter'),
  onlineCount: document.querySelector('#onlineCount'),
  lobbyStage: document.querySelector('#lobbyStage'),
  lobbyPlayerCount: document.querySelector('#lobbyPlayerCount'),
  lobbyPlayerList: document.querySelector('#lobbyPlayerList'),
  emptyPlayers: document.querySelector('#emptyPlayers'),
  gameStage: document.querySelector('#gameStage'),
  gameQuestionNumber: document.querySelector('#gameQuestionNumber'),
  phaseLabel: document.querySelector('#phaseLabel'),
  timerBox: document.querySelector('#timerBox'),
  timerValue: document.querySelector('#timerValue'),
  questionText: document.querySelector('#questionText'),
  progressCard: document.querySelector('#progressCard'),
  progressValue: document.querySelector('#progressValue'),
  progressLabel: document.querySelector('#progressLabel'),
  progressBar: document.querySelector('#progressBar'),
  phaseContent: document.querySelector('#phaseContent'),
  gameMessage: document.querySelector('#gameMessage'),
  gamePlayerCount: document.querySelector('#gamePlayerCount'),
  gamePlayerList: document.querySelector('#gamePlayerList'),
};

const statusLabels = {
  lobby: 'Lobby',
  answering: 'Răspunsuri',
  voting: 'Votare',
  question_result: 'Rezultat',
  finished: 'Final',
};

let activeSessionCode = localStorage.getItem(HOST_STORAGE_KEY) || '';
let currentState = null;

function setButtonLoading(button, loading, normalText, loadingText) {
  button.disabled = loading;
  button.textContent = loading ? loadingText : normalText;
}

function showCreateView(message = '') {
  currentState = null;
  elements.createView.hidden = false;
  elements.sessionView.hidden = true;
  elements.headerStatus.hidden = true;
  elements.newSessionButton.hidden = true;
  elements.createMessage.textContent = message;
}

function openSession(code) {
  activeSessionCode = code;
  localStorage.setItem(HOST_STORAGE_KEY, code);

  const joinUrl = new URL('/play', window.location.origin);
  joinUrl.searchParams.set('session', code);

  elements.sessionCode.textContent = code;
  elements.lobbyCode.textContent = code;
  elements.playerLink.href = joinUrl.toString();
  elements.playerLink.textContent = joinUrl.toString();
  elements.createView.hidden = true;
  elements.sessionView.hidden = false;
  elements.headerStatus.hidden = false;
  elements.newSessionButton.hidden = false;
}

function createPlayerItem(player) {
  const item = document.createElement('li');
  const avatar = document.createElement('span');
  const details = document.createElement('span');
  const name = document.createElement('strong');
  const presence = document.createElement('small');

  item.className = `player-item${player.connected ? '' : ' is-offline'}`;
  avatar.className = 'player-avatar';
  avatar.textContent = player.name.charAt(0).toUpperCase();
  details.className = 'player-details';
  name.textContent = player.name;
  presence.textContent = player.connected ? 'online' : 'offline';
  details.append(name, presence);
  item.append(avatar, details);
  return item;
}

function renderPlayers(players) {
  const connected = players.filter((player) => player.connected).length;
  elements.onlineCount.textContent = connected;
  elements.lobbyPlayerCount.textContent = players.length;
  elements.gamePlayerCount.textContent = players.length;
  elements.emptyPlayers.hidden = players.length > 0;
  elements.lobbyPlayerList.replaceChildren(...players.map(createPlayerItem));
  elements.gamePlayerList.replaceChildren(...players.map(createPlayerItem));
}

function updateProgress(value, total, label) {
  const safeTotal = Math.max(total, 1);
  elements.progressValue.textContent = `${value} / ${total}`;
  elements.progressLabel.textContent = label;
  elements.progressBar.style.width = `${Math.min(100, (value / safeTotal) * 100)}%`;
}

function createEmptyNotice(text) {
  const notice = document.createElement('div');
  notice.className = 'inline-empty';
  notice.textContent = text;
  return notice;
}

function renderVoting(state) {
  const container = document.createElement('div');
  const heading = document.createElement('h2');
  const list = document.createElement('div');
  const button = document.createElement('button');

  heading.className = 'content-title';
  heading.textContent = 'Răspunsurile sunt pe masă';
  list.className = 'answer-grid admin-answers';

  if (!state.answers?.length) {
    list.append(createEmptyNotice('Nimeni nu a trimis un răspuns la această întrebare.'));
  } else {
    for (const answer of state.answers) {
      const card = document.createElement('article');
      const text = document.createElement('p');
      const author = document.createElement('small');
      card.className = 'answer-card';
      text.textContent = answer.text;
      author.textContent = `scris de ${answer.authorName}`;
      card.append(text, author);
      list.append(card);
    }
  }

  button.className = 'button button-primary button-large button-full phase-action';
  button.type = 'button';
  button.textContent = 'Închide votarea';
  button.addEventListener('click', () => closeVoting(button));
  container.append(heading, list, button);
  elements.phaseContent.append(container);
}

function renderResults(state) {
  const container = document.createElement('div');
  const heading = document.createElement('h2');
  const list = document.createElement('div');
  const button = document.createElement('button');

  heading.className = 'content-title';
  heading.textContent = 'Verdictul publicului';
  list.className = 'results-list';

  if (!state.results?.length) {
    list.append(createEmptyNotice('Nu există răspunsuri pentru această rundă.'));
  } else {
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
      votes.textContent = `${result.voteCount} ${result.voteCount === 1 ? 'vot' : 'voturi'}`;
      body.append(text, author);
      item.append(rank, body, votes);
      list.append(item);
    });
  }

  const isLast = state.question.number === state.question.total;
  button.className = 'button button-primary button-large button-full phase-action';
  button.type = 'button';
  button.textContent = isLast ? 'Vezi clasamentul final' : 'Următoarea întrebare';
  button.addEventListener('click', () => nextQuestion(button));
  container.append(heading, list, button);
  elements.phaseContent.append(container);
}

function createLeaderboard(leaderboard) {
  const wrapper = document.createElement('div');
  const title = document.createElement('div');
  const podium = document.createElement('div');
  const rest = document.createElement('div');

  wrapper.className = 'leaderboard';
  title.className = 'final-title';
  title.innerHTML = '<span aria-hidden="true">🏆</span><h2>Clasamentul final</h2><p>Aplauze, dramă și glorie eternă.</p>';
  podium.className = 'podium';
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

  if (!leaderboard.length) {
    podium.append(createEmptyNotice('Nu există încă participanți în clasament.'));
  }

  wrapper.append(title, podium, rest);
  return wrapper;
}

function renderGame(state) {
  const { status } = state.session;
  elements.lobbyStage.hidden = true;
  elements.gameStage.hidden = false;
  elements.headerStatus.textContent = statusLabels[status];
  elements.phaseLabel.textContent = statusLabels[status];
  elements.gameMessage.textContent = '';
  elements.phaseContent.replaceChildren();
  elements.progressCard.hidden = status === 'question_result' || status === 'finished';

  if (status === 'finished') {
    elements.questionCounter.textContent = 'Joc încheiat';
    elements.gameQuestionNumber.textContent = 'Final';
    elements.questionText.textContent = 'Avem un clasament!';
    elements.timerBox.hidden = true;
    elements.phaseContent.append(createLeaderboard(state.leaderboard || []));
    return;
  }

  elements.questionCounter.textContent = `Întrebarea ${state.question.number} / ${state.question.total}`;
  elements.gameQuestionNumber.textContent = `Întrebarea ${state.question.number} / ${state.question.total}`;
  elements.questionText.textContent = state.question.text;
  elements.timerBox.hidden = status !== 'answering';
  elements.timerValue.textContent = state.timer.remaining;

  if (status === 'answering') {
    updateProgress(state.progress.answersSubmitted, state.progress.playersTotal, 'răspunsuri primite');
    elements.phaseContent.append(createEmptyNotice('Jucătorii își scriu răspunsurile. Urmărește contorul — votarea începe automat.'));
  } else if (status === 'voting') {
    updateProgress(state.progress.votesSubmitted, state.progress.playersTotal, 'voturi trimise');
    renderVoting(state);
  } else if (status === 'question_result') {
    renderResults(state);
  }
}

function renderState(state) {
  currentState = state;
  openSession(state.session.code);
  renderPlayers(state.players || []);

  if (state.session.status === 'lobby') {
    elements.headerStatus.textContent = statusLabels.lobby;
    elements.questionCounter.textContent = 'Lobby';
    elements.lobbyStage.hidden = false;
    elements.gameStage.hidden = true;
  } else {
    renderGame(state);
  }
}

function resumeSession() {
  if (!activeSessionCode || !socket.connected) {
    return;
  }

  elements.connectionMessage.hidden = false;
  elements.connectionMessage.textContent = 'Reconectăm sesiunea…';
  socket.emit('host:resume', { sessionCode: activeSessionCode }, (response) => {
    elements.connectionMessage.hidden = true;

    if (!response?.ok) {
      localStorage.removeItem(HOST_STORAGE_KEY);
      activeSessionCode = '';
      showCreateView(response?.error || 'Sesiunea nu a putut fi reluată.');
      return;
    }

    openSession(response.session.code);
  });
}

function closeVoting(button) {
  setButtonLoading(button, true, 'Închide votarea', 'Se închide…');
  socket.emit('voting:close', { sessionCode: activeSessionCode }, (response) => {
    if (!response?.ok) {
      setButtonLoading(button, false, 'Închide votarea', 'Se închide…');
      elements.gameMessage.textContent = response?.error || 'Votarea nu a putut fi închisă.';
    }
  });
}

function nextQuestion(button) {
  const normalText = button.textContent;
  setButtonLoading(button, true, normalText, 'Pregătim…');
  socket.emit('question:next', { sessionCode: activeSessionCode }, (response) => {
    if (!response?.ok) {
      setButtonLoading(button, false, normalText, 'Pregătim…');
      elements.gameMessage.textContent = response?.error || 'Nu am putut continua jocul.';
    }
  });
}

elements.createButton.addEventListener('click', () => {
  elements.createMessage.textContent = '';
  setButtonLoading(elements.createButton, true, 'Creează sesiune nouă', 'Se creează…');
  socket.emit('session:create', {}, (response) => {
    setButtonLoading(elements.createButton, false, 'Creează sesiune nouă', 'Se creează…');

    if (!response?.ok) {
      elements.createMessage.textContent = response?.error || 'Sesiunea nu a putut fi creată.';
      return;
    }

    openSession(response.session.code);
  });
});

elements.copyButton.addEventListener('click', async () => {
  elements.copyMessage.textContent = '';

  try {
    await navigator.clipboard.writeText(elements.playerLink.href);
    elements.copyMessage.textContent = 'Link copiat!';
  } catch {
    elements.copyMessage.textContent = 'Selectează linkul și copiază-l manual.';
  }
});

elements.startButton.addEventListener('click', () => {
  elements.startMessage.textContent = '';
  setButtonLoading(elements.startButton, true, 'Începe jocul', 'Pregătim întrebările…');
  socket.emit('game:start', { sessionCode: activeSessionCode }, (response) => {
    if (!response?.ok) {
      setButtonLoading(elements.startButton, false, 'Începe jocul', 'Pregătim întrebările…');
      elements.startMessage.textContent = response?.error || 'Jocul nu a putut fi pornit.';
    }
  });
});

elements.newSessionButton.addEventListener('click', () => {
  localStorage.removeItem(HOST_STORAGE_KEY);
  activeSessionCode = '';
  showCreateView();
});

socket.on('admin:state', renderState);

socket.on('timer:tick', ({ code, remaining }) => {
  if (code === activeSessionCode && currentState?.session.status === 'answering') {
    elements.timerValue.textContent = remaining;
    elements.timerBox.classList.toggle('is-urgent', remaining <= 5);
  }
});

socket.on('connect', () => {
  elements.connectionMessage.hidden = true;
  if (activeSessionCode) {
    resumeSession();
  }
});

socket.on('disconnect', () => {
  elements.connectionMessage.hidden = false;
  elements.connectionMessage.textContent = 'Conexiune întreruptă. Încercăm din nou…';
});

if (!activeSessionCode) {
  showCreateView();
}
