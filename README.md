# CrazyQ

CrazyQ este un joc live pentru grupuri: hostul afișează întrebarea, participanții răspund de pe telefon, votează răspunsul preferat și primesc puncte.

## Tehnologii

- Node.js 20+
- Express
- Socket.IO
- SQLite prin `better-sqlite3`
- HTML, CSS și JavaScript fără framework

## Instalare și pornire

```bash
npm install
npm start
```

Serverul pornește implicit la `http://localhost:3000`.

- Host: `http://localhost:3000/admin`
- Participanți: `http://localhost:3000/play`

Pentru dezvoltare, poți folosi `npm run dev` pentru restart automat la modificarea fișierelor.

## Întrebări

Întrebările se pun în:

```text
data/questions.txt
```

Sunt acceptate mai multe formate.

O întrebare pe linie:

```text
Ce superputere complet inutilă ți-ai dori?
Care este cea mai absurdă scuză pentru întârziere?
```

Linii între ghilimele:

```js
"Ce superputere complet inutilă ți-ai dori?",
"Care este cea mai absurdă scuză pentru întârziere?",
```

Sau un array JavaScript complet:

```js
const questions = [
  "Ce superputere complet inutilă ți-ai dori?",
  "Care este cea mai absurdă scuză pentru întârziere?",
];
```

La prima pornire, aplicația creează `data/crazyq.db`, creează tabelele și importă întrebările dacă tabelul `questions` este gol. Duplicatele sunt ignorate. Jocul are nevoie de minimum 10 întrebări.

Dacă vrei să refaci importul de la zero în timpul dezvoltării, oprește serverul, șterge `data/crazyq.db`, apoi pornește din nou aplicația. Fișierele SQLite auxiliare `-wal` și `-shm` pot fi șterse împreună cu baza doar cât timp serverul este oprit.

## Cum se joacă

1. Hostul deschide `/admin`, creează sesiunea și distribuie codul sau linkul.
2. Participanții intră pe `/play`, aleg un nume și dau Join.
3. Hostul pornește jocul; aplicația alege aleatoriu 10 întrebări fără repetări.
4. Pentru fiecare întrebare există 15 secunde de răspuns.
5. După expirarea timpului, participanții votează un răspuns care nu le aparține.
6. Hostul închide votarea, afișează rezultatul și trece la întrebarea următoare.
7. După întrebarea 10, clasamentul final apare pe toate ecranele.

Un vot valorează un punct pentru autorul răspunsului. La scor egal, jucătorii sunt ordonați alfabetic.

Identitatea participantului este păstrată local în browser. La refresh, acesta reintră automat cu același nume și își păstrează răspunsurile, voturile și scorul.

## Testare de pe telefon în aceeași rețea

1. Conectează laptopul și telefonul la aceeași rețea Wi-Fi.
2. Află adresa IPv4 a laptopului. Pe Windows rulează:

```powershell
ipconfig
```

3. Caută `IPv4 Address`, de exemplu `192.168.1.25`.
4. Pornește aplicația pe laptop cu `npm start`.
5. Pe telefon deschide `http://192.168.1.25:3000/play` sau linkul de participant afișat de host, înlocuind `localhost` cu IP-ul laptopului.

Dacă telefonul nu se poate conecta, permite Node.js prin Windows Firewall pentru rețeaua privată și verifică dacă routerul permite comunicarea între dispozitivele Wi-Fi.

## Persistență

SQLite păstrează întrebările, sesiunile, participanții, răspunsurile, voturile și scorurile. Socket.IO gestionează actualizările live și timerul. După repornirea serverului, o sesiune poate fi reluată, iar unei faze de răspuns active i se acordă un timer nou de 15 secunde.

## Deploy pe VPS

Aplicația trebuie rulată pe un VPS cu Node.js 20 sau mai nou. Domeniul `crazyq.example.ro` trebuie să aibă o înregistrare DNS către IP-ul VPS-ului.

Clonează proiectul și verifică pornirea:

```bash
git clone <URL-REPOSITORY> crazyq
cd crazyq
npm install
npm start
```

Comanda `npm start` rulează `node server.js`. Aplicația folosește portul din variabila de mediu `PORT`, iar în lipsa acesteia pornește pe portul `3000`.

Pentru rulare permanentă, oprește procesul pornit manual și folosește PM2:

```bash
npm install --global pm2
pm2 start server.js --name crazyq
pm2 save
pm2 startup
```

Ultima comandă afișează o comandă suplimentară care trebuie rulată cu drepturi de administrator pentru ca PM2 să pornească automat după restartarea VPS-ului.

Rulează CrazyQ într-un singur proces PM2, fără cluster mode. SQLite este local, iar timerele și conexiunile sesiunilor active sunt ținute în memoria procesului. Directorul `data/` trebuie să poată fi scris de utilizatorul care rulează aplicația și este recomandat să faci backup periodic pentru `data/crazyq.db`.

### Configurație Nginx

Exemplul următor poate fi salvat în `/etc/nginx/sites-available/crazyq`. Directiva `map` trebuie să fie în contextul `http`; fișierele încărcate din `sites-enabled` sunt în mod normal deja incluse în acest context.

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    listen [::]:80;
    server_name crazyq.example.ro;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
```

Activează configurația și reîncarcă Nginx:

```bash
sudo ln -s /etc/nginx/sites-available/crazyq /etc/nginx/sites-enabled/crazyq
sudo nginx -t
sudo systemctl reload nginx
```

Porturile publice necesare sunt `80` și `443`; portul `3000` nu trebuie expus public dacă Nginx rulează pe același VPS.

Socket.IO începe de regulă prin HTTP long-polling și face upgrade la WebSocket. Din acest motiv, headerele `Upgrade` și `Connection`, versiunea HTTP 1.1 și timeout-urile mărite din configurația de mai sus sunt necesare. Fără proxy WebSocket corect, lobby-ul poate părea conectat inițial, dar actualizările live se pot întrerupe.

După ce varianta HTTP funcționează, configurează un certificat TLS pentru `crazyq.example.ro` (de exemplu cu Certbot) și accesează aplicația prin HTTPS.
