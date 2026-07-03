# CrazyQ

CrazyQ is a live party game for groups: the host displays a question, players answer from their phones, vote for their favorite answer, and score points.

## Tech stack

- Node.js 20+
- Express
- Socket.IO
- SQLite through `better-sqlite3`
- Plain HTML, CSS, and JavaScript

## Install and run

```bash
npm install
npm start
```

By default, the server starts at `http://localhost:3000`.

- Host: `http://localhost:3000/admin`
- Players: `http://localhost:3000/play`

For development, use `npm run dev` to restart the server automatically when files change.

## Questions

Add questions to:

```text
data/questions.txt
```

The importer accepts several formats.

One question per line:

```text
What completely useless superpower would you want?
What is the most ridiculous excuse for being late?
```

Quoted lines:

```js
"What completely useless superpower would you want?",
"What is the most ridiculous excuse for being late?",
```

Or a complete JavaScript array:

```js
const questions = [
  "What completely useless superpower would you want?",
  "What is the most ridiculous excuse for being late?",
];
```

On first launch, the application creates `data/crazyq.db`, creates the tables, and imports the questions when the `questions` table is empty. Duplicates are ignored. A game needs at least 10 questions.

To rebuild the question import from scratch during development, stop the server, delete `data/crazyq.db`, and start the application again. The SQLite `-wal` and `-shm` files may be deleted with the database only while the server is stopped.

## How to play

1. The host opens `/admin`, creates a session, and shares the code or player link.
2. Players open `/play`, choose a name, and press Join.
3. The host starts the game; the application randomly selects 10 questions without repeats.
4. Players have 15 seconds to answer each question. Voting starts early when every active player has answered.
5. Players vote for an answer that is not their own.
6. The host closes voting, reveals the result, and moves to the next question.
7. After question 10, the final leaderboard appears on every screen.

Each vote gives one point to the author of that answer. Players with the same score are sorted alphabetically.

Player identity is stored locally in the browser. After a refresh, the player automatically rejoins with the same name and keeps their answers, votes, and score.

## Test from a phone on the same network

1. Connect the laptop and phone to the same Wi-Fi network.
2. Find the laptop's IPv4 address. On Windows, run:

```powershell
ipconfig
```

3. Find `IPv4 Address`, for example `192.168.1.25`.
4. Start the application on the laptop with `npm start`.
5. On the phone, open `http://192.168.1.25:3000/play`, or replace `localhost` in the player link with the laptop's IP address.

If the phone cannot connect, allow Node.js through Windows Firewall for private networks and check that the router allows communication between Wi-Fi devices.

## Persistence

SQLite stores questions, sessions, players, answers, votes, and scores. Socket.IO handles live updates and the timer. After a server restart, a session can be resumed; an active answering phase receives a fresh 15-second timer.

## Deploy to a VPS

Run the application on a VPS with Node.js 20 or newer. The DNS record for `crazyq.example.ro` must point to the VPS IP address.

Clone the project and verify that it starts:

```bash
git clone <REPOSITORY-URL> crazyq
cd crazyq
npm install
npm start
```

The `npm start` command runs `node server.js`. The application uses the `PORT` environment variable and falls back to port `3000` when it is not set.

For a persistent production process, stop the manually started server and use PM2:

```bash
npm install --global pm2
pm2 start server.js --name crazyq
pm2 save
pm2 startup
```

The last command prints an additional command that must be run with administrator privileges so PM2 starts automatically after the VPS reboots.

Run CrazyQ as a single PM2 process without cluster mode. SQLite is local, while active timers and socket connections live in process memory. The `data/` directory must be writable by the user running the application. Back up `data/crazyq.db` regularly.

### Nginx configuration

Save the following example as `/etc/nginx/sites-available/crazyq`. The `map` directive must be inside the `http` context; files loaded from `sites-enabled` are normally included there already.

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

Enable the configuration and reload Nginx:

```bash
sudo ln -s /etc/nginx/sites-available/crazyq /etc/nginx/sites-enabled/crazyq
sudo nginx -t
sudo systemctl reload nginx
```

Only ports `80` and `443` need to be public. Port `3000` should not be exposed when Nginx runs on the same VPS.

Socket.IO normally begins with HTTP long-polling and upgrades to WebSocket. The `Upgrade` and `Connection` headers, HTTP 1.1, and longer timeouts in the configuration above are required. Without correct WebSocket proxying, the lobby may appear connected at first while live updates later fail.

After the HTTP version works, configure a TLS certificate for `crazyq.example.ro`—for example, with Certbot—and use the application over HTTPS.
