const fs = require('node:fs');
const path = require('node:path');

const Database = require('better-sqlite3');

const dataDirectory = path.join(__dirname, 'data');
const databasePath = process.env.CRAZYQ_DATABASE_PATH
  ? path.resolve(process.env.CRAZYQ_DATABASE_PATH)
  : path.join(dataDirectory, 'crazyq.db');
const questionsPath = path.join(dataDirectory, 'questions.txt');

fs.mkdirSync(dataDirectory, { recursive: true });
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL UNIQUE COLLATE NOCASE
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE COLLATE NOCASE,
    status TEXT NOT NULL DEFAULT 'lobby'
      CHECK (status IN ('lobby', 'answering', 'voting', 'question_result', 'finished')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    current_question_index INTEGER NOT NULL DEFAULT -1
  );

  CREATE TABLE IF NOT EXISTS session_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    question_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (question_id) REFERENCES questions(id),
    UNIQUE (session_id, question_id),
    UNIQUE (session_id, position)
  );

  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    socket_id TEXT,
    name TEXT NOT NULL COLLATE NOCASE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    UNIQUE (session_id, name)
  );

  CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    question_id INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (question_id) REFERENCES questions(id),
    FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
    UNIQUE (session_id, question_id, player_id)
  );

  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    question_id INTEGER NOT NULL,
    voter_player_id INTEGER NOT NULL,
    answer_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (question_id) REFERENCES questions(id),
    FOREIGN KEY (voter_player_id) REFERENCES players(id) ON DELETE CASCADE,
    FOREIGN KEY (answer_id) REFERENCES answers(id) ON DELETE CASCADE,
    UNIQUE (session_id, question_id, voter_player_id)
  );

  CREATE INDEX IF NOT EXISTS idx_session_questions_session
    ON session_questions(session_id, position);
  CREATE INDEX IF NOT EXISTS idx_answers_question
    ON answers(session_id, question_id);
  CREATE INDEX IF NOT EXISTS idx_votes_question
    ON votes(session_id, question_id);
`);

const questionColumns = db.prepare('PRAGMA table_info(questions)').all();

if (!questionColumns.some((column) => column.name === 'active')) {
  db.exec(`
    ALTER TABLE questions
    ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1));
  `);
}

// Socket-urile nu supraviețuiesc unei reporniri de server.
db.prepare('UPDATE players SET socket_id = NULL').run();

function decodeJavaScriptString(value) {
  return value
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_match, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\(["'`\\])/g, '$1');
}

function extractQuotedStrings(source) {
  const strings = [];
  const stringPattern = /(["'`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g;
  let match;

  while ((match = stringPattern.exec(source)) !== null) {
    const question = decodeJavaScriptString(match[2]).trim();

    if (question) {
      strings.push(question);
    }
  }

  return strings;
}

function parseQuestionsFile(source) {
  const cleanSource = source.replace(/^\uFEFF/, '');
  const lines = cleanSource.split(/\r?\n/);
  const meaningfulLines = lines.filter((line) => line.trim() && !line.trim().startsWith('//'));
  const quotedLines = meaningfulLines.filter((line) => /^\s*(["'`]).*\1\s*,?\s*$/.test(line));
  const looksLikeArray = /(?:const|let|var)\s+\w+\s*=\s*\[/.test(cleanSource)
    || /^\s*\[/.test(cleanSource)
    || (meaningfulLines.length > 0 && quotedLines.length / meaningfulLines.length >= 0.75);

  const questions = looksLikeArray
    ? extractQuotedStrings(cleanSource)
    : meaningfulLines.map((line) => line.trim());

  const uniqueQuestions = new Map();

  for (const question of questions) {
    const normalized = question.replace(/\s+/g, ' ').trim();

    if (normalized) {
      uniqueQuestions.set(normalized.toLocaleLowerCase('ro-RO'), normalized);
    }
  }

  return Array.from(uniqueQuestions.values());
}

function syncQuestions() {
  if (!fs.existsSync(questionsPath)) {
    fs.writeFileSync(questionsPath, '', 'utf8');
  }

  const questions = parseQuestionsFile(fs.readFileSync(questionsPath, 'utf8'));
  const synchronize = db.transaction((items) => {
    const existingQuestions = db.prepare(`
      SELECT id, text
      FROM questions
      ORDER BY id ASC
    `).all();
    const existingByText = new Map(existingQuestions.map((question) => [
      question.text.toLocaleLowerCase('ro-RO'),
      question,
    ]));
    const usedIds = new Set();
    const pendingQuestions = [];
    let imported = 0;
    let updated = 0;

    db.prepare('UPDATE questions SET active = 0').run();

    const activateQuestion = db.prepare('UPDATE questions SET active = 1 WHERE id = ?');

    for (const question of items) {
      const existingQuestion = existingByText.get(question.toLocaleLowerCase('ro-RO'));

      if (existingQuestion && !usedIds.has(existingQuestion.id)) {
        activateQuestion.run(existingQuestion.id);
        usedIds.add(existingQuestion.id);
      } else {
        pendingQuestions.push(question);
      }
    }

    const reusableQuestions = existingQuestions.filter((question) => !usedIds.has(question.id));
    const updateQuestion = db.prepare('UPDATE questions SET text = ?, active = 1 WHERE id = ?');
    const insertQuestion = db.prepare('INSERT INTO questions (text, active) VALUES (?, 1)');

    for (const question of pendingQuestions) {
      const reusableQuestion = reusableQuestions.shift();

      if (reusableQuestion) {
        updateQuestion.run(question, reusableQuestion.id);
        updated += 1;
      } else {
        insertQuestion.run(question);
        imported += 1;
      }
    }

    return { imported, updated };
  });

  const result = synchronize(questions);
  const { count: total } = db.prepare(`
    SELECT COUNT(*) AS count
    FROM questions
    WHERE active = 1
  `).get();

  return { ...result, total };
}

const importResult = syncQuestions();

module.exports = {
  db,
  databasePath,
  questionsPath,
  parseQuestionsFile,
  syncQuestions,
  importResult,
};
