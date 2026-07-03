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
  answering: 'Answering',
  voting: 'Voting',
  question_result: 'Question result',
  finished: 'Finished',
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
  heading.textContent = 'The answers are in';
  list.className = 'answer-grid admin-answers';

  if (!state.answers?.length) {
    list.append(createEmptyNotice('No one submitted an answer to this question.'));
  } else {
    for (const answer of state.answers) {
      const card = document.createElement('article');
      const text = document.createElement('p');
      const author = document.createElement('small');
      card.className = 'answer-card';
      text.textContent = answer.text;
      author.textContent = `by ${answer.authorName}`;
      card.append(text, author);
      list.append(card);
    }
  }

  button.className = 'button button-primary button-large button-full phase-action';
  button.type = 'button';
  button.textContent = 'Close voting';
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
  heading.textContent = "The crowd's verdict";
  list.className = 'results-list';

  if (!state.results?.length) {
    list.append(createEmptyNotice('No answers this round.'));
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
      votes.textContent = `${result.voteCount} ${result.voteCount === 1 ? 'vote' : 'votes'}`;
      body.append(text, author);
      item.append(rank, body, votes);
      list.append(item);
    });
  }

  const isLast = state.question.number === state.question.total;
  button.className = 'button button-primary button-large button-full phase-action';
  button.type = 'button';
  button.textContent = isLast ? 'View final leaderboard' : 'Next question';
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
  title.innerHTML = '<span aria-hidden="true">🏆</span><h2>Final leaderboard</h2><p>Applause, drama, and eternal glory.</p>';
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

  if (!leaderboard.length) {
    podium.append(createEmptyNotice('No players on the leaderboard yet.'));
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
    elements.questionCounter.textContent = 'Game over';
    elements.gameQuestionNumber.textContent = 'Final';
    elements.questionText.textContent = 'We have a leaderboard!';
    elements.timerBox.hidden = true;
    elements.phaseContent.append(createLeaderboard(state.leaderboard || []));
    return;
  }

  elements.questionCounter.textContent = `Question ${state.question.number} / ${state.question.total}`;
  elements.gameQuestionNumber.textContent = `Question ${state.question.number} / ${state.question.total}`;
  elements.questionText.textContent = state.question.text;
  elements.timerBox.hidden = status !== 'answering';
  elements.timerValue.textContent = state.timer.remaining;

  if (status === 'answering') {
    updateProgress(state.progress.answersSubmitted, state.progress.playersTotal, 'answers received');
    elements.phaseContent.append(createEmptyNotice('Players are writing their answers. Keep an eye on the counter — voting starts automatically.'));
  } else if (status === 'voting') {
    updateProgress(state.progress.votesSubmitted, state.progress.playersTotal, 'votes submitted');
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
  elements.connectionMessage.textContent = 'Reconnecting to the session…';
  socket.emit('host:resume', { sessionCode: activeSessionCode }, (response) => {
    elements.connectionMessage.hidden = true;

    if (!response?.ok) {
      localStorage.removeItem(HOST_STORAGE_KEY);
      activeSessionCode = '';
      showCreateView(response?.error || 'The session could not be resumed.');
      return;
    }

    openSession(response.session.code);
  });
}

function closeVoting(button) {
  setButtonLoading(button, true, 'Close voting', 'Closing…');
  socket.emit('voting:close', { sessionCode: activeSessionCode }, (response) => {
    if (!response?.ok) {
      setButtonLoading(button, false, 'Close voting', 'Closing…');
      elements.gameMessage.textContent = response?.error || 'Voting could not be closed.';
    }
  });
}

function nextQuestion(button) {
  const normalText = button.textContent;
  setButtonLoading(button, true, normalText, 'Getting ready…');
  socket.emit('question:next', { sessionCode: activeSessionCode }, (response) => {
    if (!response?.ok) {
      setButtonLoading(button, false, normalText, 'Getting ready…');
      elements.gameMessage.textContent = response?.error || 'The game could not continue.';
    }
  });
}

elements.createButton.addEventListener('click', () => {
  elements.createMessage.textContent = '';
  setButtonLoading(elements.createButton, true, 'Create new session', 'Creating…');
  socket.emit('session:create', {}, (response) => {
    setButtonLoading(elements.createButton, false, 'Create new session', 'Creating…');

    if (!response?.ok) {
      elements.createMessage.textContent = response?.error || 'The session could not be created.';
      return;
    }

    openSession(response.session.code);
  });
});

elements.copyButton.addEventListener('click', async () => {
  elements.copyMessage.textContent = '';

  try {
    await navigator.clipboard.writeText(elements.playerLink.href);
    elements.copyMessage.textContent = 'Link copied!';
  } catch {
    elements.copyMessage.textContent = 'Select the link and copy it manually.';
  }
});

elements.startButton.addEventListener('click', () => {
  elements.startMessage.textContent = '';
  setButtonLoading(elements.startButton, true, 'Start game', 'Preparing questions…');
  socket.emit('game:start', { sessionCode: activeSessionCode }, (response) => {
    if (!response?.ok) {
      setButtonLoading(elements.startButton, false, 'Start game', 'Preparing questions…');
      elements.startMessage.textContent = response?.error || 'The game could not be started.';
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
  elements.connectionMessage.textContent = 'Connection lost. Trying again…';
});

if (!activeSessionCode) {
  showCreateView();
}
