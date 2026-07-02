# CrazyQ

Baza unei aplicații web pentru un joc live cu întrebări trăznite. În această etapă există doar lobby-ul: hostul creează o sesiune, iar participanții intră și apar live în lista lui.

## Tehnologii

- Node.js + Express
- Socket.IO
- HTML, CSS și JavaScript fără framework
- stocare în memorie (`Map`), fără bază de date

## Pornire locală

Ai nevoie de Node.js 18 sau mai nou.

```bash
npm install
npm start
```

Aplicația pornește implicit la `http://localhost:3000`:

- Host: `http://localhost:3000/admin`
- Participant: `http://localhost:3000/play`

Pentru dezvoltare, serverul poate fi pornit cu restart automat:

```bash
npm run dev
```

Poți schimba portul prin variabila de mediu `PORT`.

## Flow-ul implementat

1. Hostul deschide `/admin` și creează o sesiune.
2. Serverul generează un cod unic de 4 caractere și păstrează sesiunea în memorie.
3. Hostul distribuie linkul `/play?session=COD` sau doar codul.
4. Participantul completează numele și intră în sesiune.
5. Serverul validează sesiunea, adaugă participantul și trimite lista actualizată hostului prin Socket.IO.
6. La deconectarea unui participant, acesta dispare din lista hostului.

Sesiunea se închide când hostul se deconectează. Toate sesiunile dispar la repornirea serverului, conform limitelor acestei prime etape.

## Structură

```text
server.js          server HTTP, rute și evenimente Socket.IO
public/
  admin.html       interfața hostului
  admin.js         logica lobby-ului hostului
  play.html        interfața participantului
  play.js          logica de join
  style.css        stiluri comune și responsive
```

Întrebările, răspunsurile, scorurile și persistența nu sunt implementate încă.
