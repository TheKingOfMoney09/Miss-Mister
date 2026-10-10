// DB layer: schema + seed. Parameterized queries only.
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.sqlite');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Seed data: 7 real couples (full names, plural team names)
const SEED_COUPLERS = [
  { number: 1, team: 'Cabaret',       boy_name: 'Croitoru David',  girl_name: 'Armașu Diana',    boy_photo: '/photos/cabaret-boy.jpg',    girl_photo: '/photos/cabaret-girl.jpg' },
  { number: 2, team: 'Circ',          boy_name: 'Ionescu Ștefan',  girl_name: 'Sofronea Ștefania', boy_photo: '/photos/circ-boy.jpg',      girl_photo: '/photos/circ-girl.jpg' },
  { number: 3, team: 'Detectivi',     boy_name: 'Luca Luca Adrian', girl_name: 'Lungu Delia',    boy_photo: '/photos/detectivi-boy.jpg', girl_photo: '/photos/detectivi-girl.jpg' },
  { number: 4, team: 'Disco',         boy_name: 'Andrei Antonio',  girl_name: 'Ialâi Daniela',   boy_photo: '/photos/disco-boy.jpg',     girl_photo: '/photos/disco-girl.jpg' },
  { number: 5, team: 'Lux',           boy_name: 'Atasiei Andrei',  girl_name: 'David Sofia',     boy_photo: '/photos/lux-boy.jpg',       girl_photo: '/photos/lux-girl.jpg' },
  { number: 6, team: 'Noapte Magică', boy_name: 'Dogaru David',    girl_name: 'Ignat Diana',     boy_photo: '/photos/noapte-boy.jpg',    girl_photo: '/photos/noapte-girl.jpg' },
  { number: 7, team: 'Teatru',        boy_name: 'Palie Mihnea',    girl_name: 'Cuceanu Ruxi',    boy_photo: '/photos/teatru-boy.jpg',    girl_photo: '/photos/teatru-girl.jpg' },
];

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS couples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      number INTEGER NOT NULL UNIQUE,
      team TEXT NOT NULL DEFAULT '',
      boy_name TEXT NOT NULL,
      girl_name TEXT NOT NULL,
      boy_photo TEXT NOT NULL DEFAULT '',
      girl_photo TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      boy_couple_id INTEGER NOT NULL REFERENCES couples(id),
      girl_couple_id INTEGER NOT NULL REFERENCES couples(id),
      device_token TEXT NOT NULL UNIQUE,
      ip_hash TEXT NOT NULL,
      user_agent TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_votes_ip_time ON votes(ip_hash, created_at);
    CREATE INDEX IF NOT EXISTS idx_votes_boy ON votes(boy_couple_id);
    CREATE INDEX IF NOT EXISTS idx_votes_girl ON votes(girl_couple_id);
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      voting_open INTEGER NOT NULL DEFAULT 0,
      miss_revealed INTEGER NOT NULL DEFAULT 0,
      mister_revealed INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO settings (id, voting_open, miss_revealed, mister_revealed)
      VALUES (1, 0, 0, 0);
  `);
  // lightweight migrations for settings columns
  const cols = db.prepare('PRAGMA table_info(settings)').all().map((c) => c.name);
  if (!cols.includes('qr_visible')) db.exec('ALTER TABLE settings ADD COLUMN qr_visible INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('vote_url')) db.exec("ALTER TABLE settings ADD COLUMN vote_url TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('countdown_secs')) db.exec('ALTER TABLE settings ADD COLUMN countdown_secs INTEGER NOT NULL DEFAULT 5');

  const count = db.prepare('SELECT COUNT(*) AS c FROM couples').get().c;
  if (count === 0) {
    const ins = db.prepare(
      'INSERT INTO couples (number, team, boy_name, girl_name, boy_photo, girl_photo) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const tx = db.transaction(() => {
      for (const c of SEED_COUPLERS) ins.run(c.number, c.team, c.boy_name, c.girl_name, c.boy_photo, c.girl_photo);
    });
    tx();
    console.log('[db] seeded 7 couples');
  }
}

function getSettings() {
  return db.prepare('SELECT voting_open, miss_revealed, mister_revealed, qr_visible, vote_url, countdown_secs FROM settings WHERE id = 1').get();
}

// Everything the projector screen needs (never vote counts).
function getProjector() {
  const s = getSettings();
  return {
    voting_open: !!s.voting_open,
    miss_revealed: !!s.miss_revealed,
    mister_revealed: !!s.mister_revealed,
    qr_visible: !!s.qr_visible,
    vote_url: s.vote_url || '',
    countdown_secs: Math.min(15, Math.max(3, s.countdown_secs || 5)),
    winners: getWinners(),
  };
}

function getCouples() {
  return db.prepare('SELECT id, number, team, boy_name, girl_name, boy_photo, girl_photo FROM couples ORDER BY number').all();
}

function getStats() {
  const s = getSettings();
  const couples = getCouples();
  const total = db.prepare('SELECT COUNT(*) AS c FROM votes').get().c;
  const boyRows = db.prepare('SELECT boy_couple_id AS id, COUNT(*) AS c FROM votes GROUP BY boy_couple_id').all();
  const girlRows = db.prepare('SELECT girl_couple_id AS id, COUNT(*) AS c FROM votes GROUP BY girl_couple_id').all();
  const boyMap = new Map(boyRows.map((r) => [r.id, r.c]));
  const girlMap = new Map(girlRows.map((r) => [r.id, r.c]));
  const boys = couples
    .map((c) => ({ couple_id: c.id, number: c.number, team: c.team, name: c.boy_name, photo: c.boy_photo, votes: boyMap.get(c.id) || 0 }))
    .map((r) => ({ ...r, pct: total ? Math.round((r.votes / total) * 1000) / 10 : 0 }))
    .sort((a, b) => b.votes - a.votes);
  const girls = couples
    .map((c) => ({ couple_id: c.id, number: c.number, team: c.team, name: c.girl_name, photo: c.girl_photo, votes: girlMap.get(c.id) || 0 }))
    .map((r) => ({ ...r, pct: total ? Math.round((r.votes / total) * 1000) / 10 : 0 }))
    .sort((a, b) => b.votes - a.votes);
  // votes per minute, last 10 min
  const now = Date.now();
  const perMinute = [];
  for (let i = 9; i >= 0; i--) {
    const from = now - (i + 1) * 60000;
    const to = now - i * 60000;
    const c = db.prepare('SELECT COUNT(*) AS n FROM votes WHERE created_at > ? AND created_at <= ?').get(from, to).n;
    perMinute.push(c);
  }
  return { voting_open: !!s.voting_open, miss_revealed: !!s.miss_revealed, mister_revealed: !!s.mister_revealed, total, boys, girls, perMinute };
}

// Winners computed server-side only. Ties -> all tied.
function getWinners() {
  const s = getSettings();
  const out = { miss: null, mister: null };
  if (s.mister_revealed) {
    const rows = db.prepare(`
      SELECT c.number, c.team, c.boy_name AS name, c.boy_photo AS photo, COUNT(v.id) AS votes
      FROM couples c LEFT JOIN votes v ON v.boy_couple_id = c.id
      GROUP BY c.id ORDER BY votes DESC`).all();
    const top = rows.length ? rows[0].votes : 0;
    out.mister = rows.filter((r) => r.votes === top);
  }
  if (s.miss_revealed) {
    const rows = db.prepare(`
      SELECT c.number, c.team, c.girl_name AS name, c.girl_photo AS photo, COUNT(v.id) AS votes
      FROM couples c LEFT JOIN votes v ON v.girl_couple_id = c.id
      GROUP BY c.id ORDER BY votes DESC`).all();
    const top = rows.length ? rows[0].votes : 0;
    out.miss = rows.filter((r) => r.votes === top);
  }
  return out;
}

module.exports = { db, init, getSettings, getCouples, getStats, getWinners, getProjector, SEED_COUPLERS };
