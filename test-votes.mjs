// Test script: fires ~200 fake votes (unique device tokens), checks realtime
// admin stats, duplicate-device rejection (409), closed-voting (403),
// public results never leaking counts, reveal flow, CSV export.
// Run: node test-votes.mjs [baseUrl] [adminPassword]
// Env fallback: ADMIN_PASSWORD
const BASE = process.argv[2] || process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_PW = process.argv[3] || process.env.ADMIN_PASSWORD || '';
import { randomUUID } from 'crypto';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
async function reqRaw(method, path, { body, cookie, headers } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  // undici: use getSetCookie(), .get('set-cookie') returns null
  const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  return { status: r.status, json, text, cookies: sc };
}
async function req(method, path, opts = {}) {
  const r = await reqRaw(method, path, opts);
  return { status: r.status, json: r.json, text: r.text, setCookie: (r.cookies || []).join('; '), cookies: r.cookies || [] };
}

console.log('[test] base=' + BASE);
// 1. state: 7 couples, no counts leaked
const st = await req('GET', '/api/state');
ok('GET /api/state 200', st.status === 200);
ok('7 couples', st.json && st.json.couples && st.json.couples.length === 7, JSON.stringify(st.json && st.json.couples && st.json.couples.length));
ok('no vote counts in state', st.json && !('total' in st.json) && !('boys' in st.json));

// 2. admin login
if (!ADMIN_PW) { console.log('[test] no admin password given — skipping admin tests. Usage: node test-votes.mjs http://localhost:3000 <parola>'); process.exit(fail ? 1 : 0); }
const login = await req('POST', '/api/admin/login', { body: { password: ADMIN_PW } });
ok('admin login 200', login.status === 200, login.text.slice(0, 120));
const jar = (login.cookies || []).map((c) => c.split(';')[0].trim());
const adminCookie = jar.find((c) => c.startsWith('connect.sid=')) || '';
const A = (m, p, b) => req(m, p, { body: b, cookie: adminCookie });

// 3. open voting
await A('POST', '/api/admin/voting', { open: true });
const st2 = await req('GET', '/api/state');
ok('voting open', st2.json && st2.json.voting_open === true);

// 4. fire 200 fake votes with unique device tokens
const couples = st2.json.couples;
const pick = () => couples[Math.floor(Math.random() * couples.length)].id;
let okVotes = 0, dupRejected = 0;
const firstToken = randomUUID();
for (let i = 0; i < 200; i++) {
  const tok = i === 0 ? firstToken : randomUUID();
  const r = await req('POST', '/api/vote', { body: { boy_couple_id: pick(), girl_couple_id: pick(), device_token: tok }, headers: { 'X-Device-Token': tok } });
  if (r.status === 200) okVotes++;
}
// duplicate from same device token -> 409
const dup = await req('POST', '/api/vote', { body: { boy_couple_id: couples[0].id, girl_couple_id: couples[0].id, device_token: firstToken }, headers: { 'X-Device-Token': firstToken } });
if (dup.status === 409) dupRejected++;
ok('200 unique votes accepted', okVotes === 200, 'accepted=' + okVotes);
ok('duplicate device rejected 409', dupRejected === 1, 'status=' + dup.status);

// 5. admin stats realtime
const stats = await A('GET', '/api/admin/stats');
ok('stats total=200', stats.json && stats.json.total === 200, JSON.stringify(stats.json && stats.json.total));
ok('boys sorted desc', !!(stats.json && stats.json.boys && stats.json.boys[0].votes >= stats.json.boys[6].votes));
ok('girls have pct', !!(stats.json && stats.json.girls && typeof stats.json.girls[0].pct === 'number'));
ok('perMinute array(10)', stats.json && Array.isArray(stats.json.perMinute) && stats.json.perMinute.length === 10);

// 6. public results: no counts before reveal
const res1 = await req('GET', '/api/results');
ok('results: winners null before reveal', res1.json && res1.json.winners.miss === null && res1.json.winners.mister === null);
ok('results: no counts leaked', res1.json && !('total' in res1.json) && !('boys' in res1.json));

// 7. reveal mister only -> miss stays hidden
await A('POST', '/api/admin/reveal', { which: 'mister', value: 1 });
const res2 = await req('GET', '/api/results');
ok('mister revealed, miss hidden', res2.json && Array.isArray(res2.json.winners.mister) && res2.json.winners.miss === null);
await A('POST', '/api/admin/reveal', { which: 'miss', value: 1 });
const res3 = await req('GET', '/api/results');
ok('both revealed', res3.json && Array.isArray(res3.json.winners.miss) && Array.isArray(res3.json.winners.mister));

// 8. SSE public emits state (read first event)
{
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(BASE + '/api/events', { signal: ctrl.signal });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value); if (buf.includes('event: state')) break; }
    clearTimeout(t);
    ok('SSE public event received', buf.includes('event: state'));
  } catch (e) { ok('SSE public event received', false, String(e)); }
}

// 9. CSV export
{
  const r = await fetch(BASE + '/api/admin/export.csv', { headers: { Cookie: adminCookie } });
  const t = await r.text();
  ok('CSV export 200 rows', r.status === 200 && t.split('\n').length >= 200, 'lines=' + t.split('\n').length);
}

// 10. close voting -> 403
await A('POST', '/api/admin/voting', { open: false });
const closed = await req('POST', '/api/vote', { body: { boy_couple_id: couples[0].id, girl_couple_id: couples[0].id, device_token: randomUUID() } });
ok('closed voting -> 403', closed.status === 403, 'status=' + closed.status);

// cleanup: hide reveals + reset votes (fresh for event)
await A('POST', '/api/admin/reveal', { which: 'miss', value: 0 });
await A('POST', '/api/admin/reveal', { which: 'mister', value: 0 });
await A('POST', '/api/admin/reset', { confirm: 'RESET' });
const stats0 = await A('GET', '/api/admin/stats');
ok('reset -> total 0', stats0.json && stats0.json.total === 0);

console.log(`[test] DONE pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
