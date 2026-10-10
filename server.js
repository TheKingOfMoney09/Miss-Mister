// Miss & Mister voting app — Node + Express + SQLite + SSE
require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const sharp = require('sharp');
const QRCode = require('qrcode');
const os = require('os');

const { db, init, getSettings, getCouples, getStats, getWinners, getProjector } = require('./db');

const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'schimba-ma';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const IP_SALT = process.env.IP_SALT || 'dev-salt-change-me';
// Theater shares one WiFi IP -> keep per-IP guards generous & configurable.
const IP_HOURLY_CAP = parseInt(process.env.IP_HOURLY_CAP || '500', 10);

init();

const app = express();
app.set('trust proxy', 1); // respect X-Forwarded-For behind proxy
app.use(helmet({ contentSecurityPolicy: false })); // plain inline HTML/JS
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 12 * 3600 * 1000 },
  })
);

// ---------- static ----------
app.use(express.static(path.join(__dirname, 'public')));
app.use('/photos', express.static(path.join(__dirname, 'public', 'photos')));
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR));

// ---------- device token (ONE vote per device) ----------
// Server issues random UUID as httpOnly cookie on first visit.
// Client also mirrors it in localStorage + IndexedDB and sends it back;
// server accepts any of the three and restores missing ones.
function ensureDeviceToken(req, res, next) {
  let token = req.cookies && req.cookies.device_token;
  const fallback = (req.body && req.body.device_token) || req.get('X-Device-Token');
  if (!token && fallback && typeof fallback === 'string' && fallback.length >= 8 && fallback.length <= 128) {
    token = fallback;
  }
  if (!token) token = crypto.randomUUID();
  if (!req.cookies || req.cookies.device_token !== token) {
    res.cookie('device_token', token, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 365 * 24 * 3600 * 1000 });
  }
  req.deviceToken = token;
  next();
}
app.use(ensureDeviceToken);

// ---------- SSE hubs ----------
const publicClients = new Set();
const adminClients = new Set();
function dropClient(res) {
  publicClients.delete(res);
  adminClients.delete(res);
  try { res.end(); } catch {}
}
// One dead socket must never break the broadcast for everyone else.
function sseSendSafe(set, res, event, data) {
  try {
    if (res.destroyed || res.writableEnded) { dropClient(res); return; }
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    dropClient(res);
  }
}
function broadcastPublic() {
  const s = getSettings();
  const payload = { voting_open: !!s.voting_open, miss_revealed: !!s.miss_revealed, mister_revealed: !!s.mister_revealed, winners: getWinners(), qr_visible: !!s.qr_visible, vote_url: s.vote_url || '', countdown_secs: Math.min(15, Math.max(3, s.countdown_secs || 5)) };
  for (const res of Array.from(publicClients)) sseSendSafe(publicClients, res, 'state', payload);
}
function broadcastAdmin() {
  const payload = getStats();
  for (const res of Array.from(adminClients)) sseSendSafe(adminClients, res, 'stats', payload);
}
function broadcastAll() {
  broadcastPublic();
  broadcastAdmin();
}

// ---------- helpers ----------
function esc(s) {
  return String(s == null ? '' : s);
}
function clientIp(req) {
  return esc(req.ip || (req.connection && req.connection.remoteAddress) || '');
}
function ipHash(ip) {
  return crypto.createHash('sha256').update(ip + IP_SALT).digest('hex');
}
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.status(401).json({ error: 'neautorizat' });
}

// ---------- rate limits ----------
const voteLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

// ---------- pages ----------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/thanks', (req, res) => res.sendFile(path.join(__dirname, 'public', 'thanks.html')));
app.get('/results', (req, res) => res.sendFile(path.join(__dirname, 'public', 'results.html')));
app.get('/projector', (req, res) => res.sendFile(path.join(__dirname, 'public', 'projector.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ---------- public API ----------
// Never exposes vote counts.
app.get('/api/state', (req, res) => {
  const s = getSettings();
  res.json({
    voting_open: !!s.voting_open,
    miss_revealed: !!s.miss_revealed,
    mister_revealed: !!s.mister_revealed,
    couples: getCouples(),
    device_token: req.deviceToken,
  });
});

app.get('/api/results', (req, res) => {
  const s = getSettings();
  res.json({
    voting_open: !!s.voting_open,
    miss_revealed: !!s.miss_revealed,
    mister_revealed: !!s.mister_revealed,
    winners: getWinners(),
  });
});

// Projector screen state (public, never vote counts).
app.get('/api/projector', (req, res) => res.json(getProjector()));

// QR code PNG for the vote URL (public). Regenerated only when the URL changes.
let qrCache = { text: null, png: null };
app.get('/api/qr.png', async (req, res) => {
  const s = getSettings();
  const text = (s.vote_url || '').trim();
  if (!text) return res.status(404).json({ error: 'URL vot nesetat.' });
  try {
    if (qrCache.text !== text) {
      qrCache = { text, png: await QRCode.toBuffer(text, { width: 640, margin: 2, color: { dark: '#000000', light: '#ffffff' } }) };
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(qrCache.png);
  } catch (e) {
    res.status(500).json({ error: 'Eroare QR.' });
  }
});

app.post('/api/vote', voteLimiter, (req, res) => {
  const s = getSettings();
  if (!s.voting_open) return res.status(403).json({ error: 'Votarea e închisă.' });

  const boyId = Number(req.body && req.body.boy_couple_id);
  const girlId = Number(req.body && req.body.girl_couple_id);
  if (!Number.isInteger(boyId) || !Number.isInteger(girlId)) {
    return res.status(400).json({ error: 'Alege un Mister și un Miss.' });
  }
  const exists = db.prepare('SELECT COUNT(*) AS c FROM couples WHERE id = ? OR id = ?').get(boyId, girlId).c;
  const need = boyId === girlId ? 1 : 2;
  if (exists < need) return res.status(400).json({ error: 'Selecție invalidă.' });

  // SOFT IP cap (shared venue WiFi): max IP_HOURLY_CAP votes per IP hash per hour
  const hash = ipHash(clientIp(req));
  const oneHourAgo = Date.now() - 3600 * 1000;
  const ipCount = db.prepare('SELECT COUNT(*) AS c FROM votes WHERE ip_hash = ? AND created_at > ?').get(hash, oneHourAgo).c;
  if (ipCount >= IP_HOURLY_CAP) return res.status(429).json({ error: 'Prea multe voturi din această rețea. Încearcă mai târziu.' });

  try {
    db.prepare(
      'INSERT INTO votes (boy_couple_id, girl_couple_id, device_token, ip_hash, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(boyId, girlId, req.deviceToken, hash, esc(req.get('User-Agent') || '').slice(0, 300), Date.now());
  } catch (e) {
    if (e && e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Ai votat deja de pe acest dispozitiv.' });
    }
    throw e;
  }
  broadcastAll();
  res.json({ ok: true });
});

// Has THIS device voted? Server is source of truth (lets admin "forget"
// a device so it can revote even though its localStorage still says voted).
app.get('/api/me', (req, res) => {
  const row = db.prepare('SELECT id FROM votes WHERE device_token = ?').get(req.deviceToken);
  res.json({ voted: !!row, device_token: req.deviceToken });
});

// Public SSE: state + reveal changes only (never counts)
app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  publicClients.add(res);
  const s = getSettings();
  sseSendSafe(publicClients, res, 'state', {
    voting_open: !!s.voting_open,
    miss_revealed: !!s.miss_revealed,
    mister_revealed: !!s.mister_revealed,
    winners: getWinners(),
    qr_visible: !!s.qr_visible,
    vote_url: s.vote_url || '',
    countdown_secs: Math.min(15, Math.max(3, s.countdown_secs || 5)),
  });
  const hb = setInterval(() => { try { if (!res.destroyed && !res.writableEnded) res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => {
    clearInterval(hb);
    publicClients.delete(res);
  });
});

// ---------- admin API ----------
app.post('/api/admin/login', loginLimiter, (req, res) => {
  const pw = (req.body && req.body.password) || '';
  if (typeof pw === 'string' && pw.length > 0 && crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(ADMIN_PASSWORD))) {
    req.session.admin = true;
    return res.json({ ok: true });
  }
  // avoid timing oracle on length mismatch
  return res.status(401).json({ error: 'Parolă greșită.' });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/admin/stats', requireAdmin, (req, res) => res.json(getStats()));

app.post('/api/admin/voting', requireAdmin, (req, res) => {
  const open = req.body && (req.body.open === true || req.body.open === 1 || req.body.open === '1') ? 1 : 0;
  db.prepare('UPDATE settings SET voting_open = ? WHERE id = 1').run(open);
  broadcastAll();
  res.json({ ok: true, voting_open: !!open });
});

app.post('/api/admin/reveal', requireAdmin, (req, res) => {
  const which = (req.body && req.body.which) || '';
  const value = req.body && (req.body.value === true || req.body.value === 1 || req.body.value === '1') ? 1 : 0;
  if (which !== 'miss' && which !== 'mister') return res.status(400).json({ error: 'which must be miss|mister' });
  db.prepare(`UPDATE settings SET ${which === 'miss' ? 'miss_revealed' : 'mister_revealed'} = ? WHERE id = 1`).run(value);
  broadcastAll();
  res.json({ ok: true });
});

app.post('/api/admin/reveal-both', requireAdmin, (req, res) => {
  const value = req.body && (req.body.value === true || req.body.value === 1 || req.body.value === '1') ? 1 : 0;
  db.prepare('UPDATE settings SET miss_revealed = ?, mister_revealed = ? WHERE id = 1').run(value, value);
  broadcastAll();
  res.json({ ok: true, value: !!value });
});

app.post('/api/admin/reset', requireAdmin, (req, res) => {
  if (!req.body || req.body.confirm !== 'RESET') return res.status(400).json({ error: 'Confirmă cu RESET.' });
  db.prepare('DELETE FROM votes').run();
  broadcastAll();
  res.json({ ok: true });
});

app.get('/api/admin/export.csv', requireAdmin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT v.id, v.created_at, cb.number AS boy_number, cb.boy_name, cg.number AS girl_number, cg.girl_name
       FROM votes v JOIN couples cb ON cb.id = v.boy_couple_id JOIN couples cg ON cg.id = v.girl_couple_id
       ORDER BY v.id`
    )
    .all();
  const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = ['id,created_at,boy_number,boy_name,girl_number,girl_name'];
  for (const r of rows) lines.push([r.id, new Date(r.created_at).toISOString(), r.boy_number, q(r.boy_name), r.girl_number, q(r.girl_name)].join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="voturi.csv"');
  res.send('\uFEFF' + lines.join('\n'));
});

app.get('/api/admin/couples', requireAdmin, (req, res) => res.json(getCouples()));

app.put('/api/admin/couples/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT id FROM couples WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Couple not found.' });
  const b = req.body || {};
  const cur = db.prepare('SELECT * FROM couples WHERE id = ?').get(id);
  const boy_name = typeof b.boy_name === 'string' && b.boy_name.trim() ? b.boy_name.trim().slice(0, 120) : cur.boy_name;
  const girl_name = typeof b.girl_name === 'string' && b.girl_name.trim() ? b.girl_name.trim().slice(0, 120) : cur.girl_name;
  const team = typeof b.team === 'string' ? b.team.trim().slice(0, 120) : cur.team;
  const number = Number.isInteger(Number(b.number)) ? Number(b.number) : cur.number;
  try {
    db.prepare('UPDATE couples SET boy_name = ?, girl_name = ?, team = ?, number = ? WHERE id = ?').run(boy_name, girl_name, team, number, id);
  } catch (e) {
    if (e && e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(400).json({ error: 'Număr duplicat.' });
    throw e;
  }
  broadcastAdmin();
  res.json({ ok: true });
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
app.post('/api/admin/couples/:id/photo', requireAdmin, upload.single('photo'), async (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT id FROM couples WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Couple not found.' });
  const side = (req.body && req.body.side) || '';
  if (side !== 'boy' && side !== 'girl') return res.status(400).json({ error: 'side must be boy|girl' });
  if (!req.file) return res.status(400).json({ error: 'Lipsește fișierul photo.' });
  const fname = `c${id}-${side}-${Date.now()}.jpg`;
  const out = path.join(UPLOAD_DIR, fname);
  await sharp(req.file.buffer).rotate().resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(out);
  const col = side === 'boy' ? 'boy_photo' : 'girl_photo';
  db.prepare(`UPDATE couples SET ${col} = ? WHERE id = ?`).run('/uploads/' + fname, id);
  broadcastAdmin();
  res.json({ ok: true, url: '/uploads/' + fname });
});

// Projector screen config (admin): QR visibility + vote URL + countdown length.
app.post('/api/admin/projector', requireAdmin, (req, res) => {
  const b = req.body || {};
  const qr_visible = b.qr_visible === true || b.qr_visible === 1 || b.qr_visible === '1' ? 1 : 0;
  let vote_url = typeof b.vote_url === 'string' ? b.vote_url.trim().slice(0, 200) : '';
  if (vote_url && !/^https?:\/\//i.test(vote_url)) return res.status(400).json({ error: 'URL-ul trebuie să înceapă cu http:// sau https://' });
  let countdown_secs = parseInt(b.countdown_secs, 10);
  if (!Number.isFinite(countdown_secs)) countdown_secs = 5;
  countdown_secs = Math.min(15, Math.max(3, countdown_secs));
  db.prepare('UPDATE settings SET qr_visible = ?, vote_url = ?, countdown_secs = ? WHERE id = 1').run(qr_visible, vote_url, countdown_secs);
  broadcastAll();
  res.json({ ok: true, qr_visible: !!qr_visible, vote_url, countdown_secs });
});

// Suggest the LAN URL voters should use (admin helper for the QR).
app.get('/api/admin/net', requireAdmin, (req, res) => {
  let lanIp = '';
  for (const ifs of Object.values(os.networkInterfaces())) {
    for (const a of ifs || []) {
      if (a.family === 'IPv4' && !a.internal) { lanIp = a.address; break; }
    }
    if (lanIp) break;
  }
  res.json({ lanIp, port: PORT, guessUrl: lanIp ? `http://${lanIp}:${PORT}/` : '' });
});

// Recent votes (admin only): lets admin "forget" one device so it can revote.
// Device tokens are shown truncated — full tokens never leave the server.
app.get('/api/admin/votes', requireAdmin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT v.id, v.created_at,
              substr(v.device_token, 1, 8) AS device_short,
              cb.number AS boy_number, cb.boy_name, cg.number AS girl_number, cg.girl_name
       FROM votes v JOIN couples cb ON cb.id = v.boy_couple_id JOIN couples cg ON cg.id = v.girl_couple_id
       ORDER BY v.id DESC LIMIT 100`
    )
    .all();
  res.json(rows);
});

// Forget ONE vote -> that device can vote again.
app.delete('/api/admin/votes/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const info = db.prepare('DELETE FROM votes WHERE id = ?').run(id);
  if (!info.changes) return res.status(404).json({ error: 'Vot inexistent.' });
  broadcastAll();
  res.json({ ok: true });
});

app.get('/api/admin/events', requireAdmin, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  adminClients.add(res);
  sseSendSafe(adminClients, res, 'stats', getStats());
  const hb = setInterval(() => { try { if (!res.destroyed && !res.writableEnded) res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => {
    clearInterval(hb);
    adminClients.delete(res);
  });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[err]', err && err.message);
  res.status(500).json({ error: 'Eroare internă.' });
});

app.listen(PORT, () => console.log(`[mm] voting app on http://localhost:${PORT}`));
