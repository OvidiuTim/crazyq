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
