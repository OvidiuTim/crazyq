const socket = io();

const joinCard = document.querySelector('#joinCard');
const joinForm = document.querySelector('#joinForm');
const sessionInput = document.querySelector('#sessionInput');
const nameInput = document.querySelector('#nameInput');
const joinButton = document.querySelector('#joinButton');
const joinMessage = document.querySelector('#joinMessage');
const joinedCard = document.querySelector('#joinedCard');
const joinedName = document.querySelector('#joinedName');
const joinedCode = document.querySelector('#joinedCode');
const sessionMessage = document.querySelector('#sessionMessage');

const sessionFromUrl = new URLSearchParams(window.location.search).get('session');

if (sessionFromUrl) {
  sessionInput.value = sessionFromUrl.trim().toUpperCase().slice(0, 4);
  nameInput.focus();
}

sessionInput.addEventListener('input', () => {
  sessionInput.value = sessionInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
});

function setJoining(isJoining) {
  joinButton.disabled = isJoining;
  joinButton.textContent = isJoining ? 'Intrăm…' : 'Join';
}

joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  joinMessage.textContent = '';

  const sessionCode = sessionInput.value.trim().toUpperCase();
  const name = nameInput.value.trim();

  if (sessionCode.length !== 4) {
    joinMessage.textContent = 'Codul trebuie să aibă 4 caractere.';
    sessionInput.focus();
    return;
  }

  if (!name) {
    joinMessage.textContent = 'Scrie numele tău ca să poți intra.';
    nameInput.focus();
    return;
  }

  setJoining(true);
  socket.emit('player:join', { sessionCode, name }, (response) => {
    setJoining(false);

    if (!response?.ok) {
      joinMessage.textContent = response?.error || 'Nu am putut intra în sesiune.';
      return;
    }

    joinedName.textContent = response.player.name;
    joinedCode.textContent = response.session.code;
    joinCard.hidden = true;
    joinedCard.hidden = false;
  });
});

socket.on('session:closed', () => {
  if (!joinedCard.hidden) {
    sessionMessage.textContent = 'Hostul a închis sesiunea.';
  }
});

socket.on('disconnect', () => {
  const target = joinedCard.hidden ? joinMessage : sessionMessage;
  target.textContent = 'Conexiunea cu serverul s-a întrerupt.';
});
