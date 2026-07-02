const socket = io();

const createPanel = document.querySelector('#createPanel');
const createSessionButton = document.querySelector('#createSessionButton');
const createMessage = document.querySelector('#createMessage');
const lobbyPanel = document.querySelector('#lobbyPanel');
const sessionCode = document.querySelector('#sessionCode');
const playerLink = document.querySelector('#playerLink');
const copyLinkButton = document.querySelector('#copyLinkButton');
const copyMessage = document.querySelector('#copyMessage');
const startGameButton = document.querySelector('#startGameButton');
const startMessage = document.querySelector('#startMessage');
const playerCount = document.querySelector('#playerCount');
const emptyPlayers = document.querySelector('#emptyPlayers');
const playerList = document.querySelector('#playerList');

let activeSessionCode = '';

function setCreating(isCreating) {
  createSessionButton.disabled = isCreating;
  createSessionButton.textContent = isCreating ? 'Se creează…' : 'Creează sesiune nouă';
}

function renderPlayers(players) {
  playerList.replaceChildren();
  playerCount.textContent = players.length;
  playerCount.setAttribute('aria-label', `${players.length} participanți`);
  emptyPlayers.hidden = players.length > 0;

  for (const player of players) {
    const item = document.createElement('li');
    const avatar = document.createElement('span');
    const name = document.createElement('span');

    item.className = 'player-item';
    avatar.className = 'player-avatar';
    avatar.textContent = player.name.charAt(0).toUpperCase();
    name.textContent = player.name;

    item.append(avatar, name);
    playerList.append(item);
  }
}

createSessionButton.addEventListener('click', () => {
  createMessage.textContent = '';
  setCreating(true);

  socket.emit('session:create', {}, (response) => {
    setCreating(false);

    if (!response?.ok) {
      createMessage.textContent = response?.error || 'Sesiunea nu a putut fi creată.';
      return;
    }

    activeSessionCode = response.session.code;
    const joinUrl = new URL('/play', window.location.origin);
    joinUrl.searchParams.set('session', activeSessionCode);

    sessionCode.textContent = activeSessionCode;
    playerLink.href = joinUrl.toString();
    playerLink.textContent = joinUrl.toString();
    createPanel.hidden = true;
    lobbyPanel.hidden = false;
    renderPlayers([]);
  });
});

copyLinkButton.addEventListener('click', async () => {
  copyMessage.textContent = '';

  try {
    await navigator.clipboard.writeText(playerLink.href);
    copyMessage.textContent = 'Link copiat!';
  } catch {
    copyMessage.textContent = 'Selectează și copiază linkul de mai sus.';
  }
});

startGameButton.addEventListener('click', () => {
  startMessage.textContent = 'Totul e pregătit — întrebările vin în pasul următor.';
});

socket.on('session:players', ({ code, players }) => {
  if (code === activeSessionCode && Array.isArray(players)) {
    renderPlayers(players);
  }
});

socket.on('disconnect', () => {
  if (activeSessionCode) {
    startMessage.textContent = 'Conexiunea cu serverul s-a întrerupt. Reîncarcă pagina pentru o sesiune nouă.';
  }
});
