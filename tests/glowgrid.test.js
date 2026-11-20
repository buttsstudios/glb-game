// Run: node --test tests/   (Node 18+; no dependencies)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { issueToken, verifyToken } = require('../api/_entitlement');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function loadFns(FakeDate) {
  const k = html.match(/function todayKey\(\)[^\n]*/)[0];
  const sd = html.match(/function todaySeed\(\)[^\n]*/)[0];
  return new Function('Date', k + '\n' + sd + '\nreturn { todayKey, todaySeed };')(FakeDate);
}
function fakeDate(iso) { const t = Date.parse(iso); return class extends Date { constructor(...a) { a.length ? super(...a) : super(t); } }; }

test('daily seed is a UTC date seed (same derivation YYYYMMDD)', () => {
  const f = loadFns(fakeDate('2026-11-20T23:30:00Z'));
  assert.strictEqual(f.todayKey(), '2026-11-20');
  assert.strictEqual(f.todaySeed(), 20261120);
});
test('seed does not depend on the process timezone', () => {
  const orig = process.env.TZ;
  for (const tz of ['Pacific/Kiritimati', 'America/Los_Angeles', 'UTC', 'Asia/Tokyo']) {
    process.env.TZ = tz;
    assert.strictEqual(loadFns(fakeDate('2026-01-01T00:30:00Z')).todaySeed(), 20260101, tz);
    assert.strictEqual(loadFns(fakeDate('2026-12-31T23:59:59Z')).todaySeed(), 20261231, tz);
  }
  process.env.TZ = orig;
});
test('footer has Contact and the Glowgrid legal links; no draft pages linked', () => {
  assert.match(html, /href="https:\/\/buttsstudios\.com\/contact">Contact</);
  for (const p of ['terms', 'refunds', 'privacy']) assert.match(html, new RegExp('games/glowgrid/' + p + '"'));
  assert.doesNotMatch(html, /buttsstudios\.com\/(terms|refunds|privacy)"/);
});

const SID = 'cs_test_a1B2c3D4';
test('token round trip', () => {
  const t = issueToken('s3cret-s3cret-s3cret-s3cret-123456', SID);
  assert.strictEqual(verifyToken('s3cret-s3cret-s3cret-s3cret-123456', t).sid, SID);
});
test('token rejected: wrong secret, tampered, expired, malformed, no secret', () => {
  const sec = 'k'.repeat(40);
  const t = issueToken(sec, SID, Date.now());
  assert.strictEqual(verifyToken('x'.repeat(40), t), null);
  const [b, m] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ v: 1, sid: SID, iat: 1, exp: 9999999999 })).toString('base64url');
  assert.strictEqual(verifyToken(sec, forged + '.' + m), null);
  assert.strictEqual(verifyToken(sec, b + '.' + m.slice(0, -2) + 'AA'), null);
  assert.strictEqual(verifyToken(sec, issueToken(sec, SID, Date.now() - 4000 * 86400e3)), null);
  assert.strictEqual(verifyToken(sec, 'true'), null);
  assert.strictEqual(verifyToken(sec, ''), null);
  assert.strictEqual(issueToken('', SID), null);
  assert.strictEqual(verifyToken('', t), null);
});

function mockRes() { const r = { headers: {}, setHeader(k, v) { r.headers[k] = v; }, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; }
function withEnv(env, fn) { const old = {}; for (const k of Object.keys(env)) { old[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; } return Promise.resolve(fn()).finally(() => { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }); }

test('verify-purchase (Stripe mocked): paid session on allowed link returns premium + token; unpaid does not; link mismatch does not', async () => {
  const sec = 'q'.repeat(40);
  const realFetch = global.fetch;
  const vp = require('../api/verify-purchase');
  const sess = { status: 'complete', payment_status: 'paid', payment_link: 'plink_ok' };
  global.fetch = async () => ({ ok: true, json: async () => sess });
  try {
    await withEnv({ STRIPE_READ_KEY: 'rk_test_x', PREMIUM_PAYMENT_LINKS: 'plink_ok', ENTITLEMENT_SECRET: sec }, async () => {
      let r = mockRes(); await vp({ query: { session_id: SID } }, r);
      assert.strictEqual(r.code, 200); assert.strictEqual(r.body.premium, true);
      assert.strictEqual(verifyToken(sec, r.body.token).sid, SID);
      sess.payment_status = 'unpaid'; r = mockRes(); await vp({ query: { session_id: SID } }, r);
      assert.strictEqual(r.code, 402); assert.strictEqual(r.body.token, undefined);
      sess.payment_status = 'paid'; sess.payment_link = 'plink_other'; r = mockRes(); await vp({ query: { session_id: SID } }, r);
      assert.strictEqual(r.code, 402);
      r = mockRes(); await vp({ query: { session_id: 'true' } }, r); assert.strictEqual(r.code, 400);
    });
    // no secret: behaves exactly as before (premium, no token)
    sess.payment_link = 'plink_ok';
    await withEnv({ STRIPE_READ_KEY: 'rk_test_x', PREMIUM_PAYMENT_LINKS: 'plink_ok', ENTITLEMENT_SECRET: undefined }, async () => {
      const r = mockRes(); await vp({ query: { session_id: SID } }, r);
      assert.strictEqual(r.code, 200); assert.deepStrictEqual(r.body, { premium: true });
    });
  } finally { global.fetch = realFetch; }
});

test('entitlement endpoint: default OFF; valid token premium; invalid token not; enforce+grace reported', async () => {
  const ent = require('../api/entitlement');
  const sec = 'z'.repeat(40);
  const tok = issueToken(sec, SID);
  await withEnv({ ENTITLEMENT_SECRET: sec, GLOWGRID_ENFORCE_TOKEN: undefined, GLOWGRID_LEGACY_GRACE_UNTIL: undefined }, async () => {
    let r = mockRes(); await ent({ query: { token: tok } }, r);
    assert.deepStrictEqual(r.body, { premium: true, enforce: false, graceUntil: null });
    r = mockRes(); await ent({ query: { token: 'true' } }, r);
    assert.deepStrictEqual(r.body, { premium: false, enforce: false, graceUntil: null });
    r = mockRes(); await ent({ query: {} }, r); assert.strictEqual(r.body.premium, false);
  });
  await withEnv({ ENTITLEMENT_SECRET: sec, GLOWGRID_ENFORCE_TOKEN: '1', GLOWGRID_LEGACY_GRACE_UNTIL: '2027-01-31' }, async () => {
    const r = mockRes(); await ent({ query: {} }, r);
    assert.deepStrictEqual(r.body, { premium: false, enforce: true, graceUntil: '2027-01-31T00:00:00.000Z' });
  });
});

// ---- enforcement-on coverage (HQ4-42): clock-injected grace, fail-open, client flow with mocked /api/entitlement ----
function loadEnt() {
  const m = html.match(/\/\/ ENT-BEGIN[^\n]*\n([\s\S]*?)\/\/ ENT-END/);
  assert.ok(m, 'ENT block present');
  return new Function('ENTITLEMENT_KEY', m[1] + '\nreturn { entitlementDecision, checkEntitlement };')('glowgrid_entitlement');
}
const { entitlementDecision, checkEntitlement } = loadEnt();
const GRACE = '2026-12-20T00:00:00.000Z';
const jsonRes = (o) => ({ json: () => Promise.resolve(o) });
function env(over) {
  const store = Object.assign({}, over.store || {});
  const calls = [];
  return Object.assign({ sessionId: null, get: (k, d) => (k in store ? store[k] : d), isPremium: false, base: '/games/glowgrid/', now: () => Date.parse('2026-11-20T12:00:00Z'),
    fetch: (u) => { calls.push(u); return Promise.resolve(jsonRes({ premium: false, enforce: true, graceUntil: GRACE })); } }, over, { calls });
}

test('legacy flag honoured before the grace date and rejected after (injected clock)', () => {
  const d = { premium: false, enforce: true, graceUntil: GRACE };
  assert.strictEqual(entitlementDecision(d, Date.parse('2026-12-19T23:59:59Z'), true), true);
  assert.strictEqual(entitlementDecision(d, Date.parse(GRACE), true), false);
  assert.strictEqual(entitlementDecision(d, Date.parse('2027-01-01T00:00:00Z'), true), false);
  assert.strictEqual(entitlementDecision({ premium: false, enforce: true, graceUntil: null }, 0, true), false); // no grace set
  assert.strictEqual(entitlementDecision({ premium: false, enforce: false, graceUntil: null }, Date.parse('2030-01-01'), true), true); // flag off: unchanged
  assert.strictEqual(entitlementDecision({ premium: true, enforce: true, graceUntil: null }, Date.parse('2030-01-01'), false), true); // valid token always unlocks
  assert.strictEqual(entitlementDecision(null, 0, true), true);
  assert.strictEqual(entitlementDecision({ premium: false, enforce: true, graceUntil: GRACE }, Date.parse('2026-11-20'), false), false); // fresh visitor stays locked
});

test('client flow: legacy flag, before and after grace, mocked endpoint', async () => {
  let e = env({ isPremium: true });
  assert.strictEqual(await checkEntitlement(e), true);
  assert.ok(e.calls[0].startsWith('/games/glowgrid/api/entitlement?token='));
  e = env({ isPremium: true, now: () => Date.parse('2026-12-21T00:00:00Z') });
  assert.strictEqual(await checkEntitlement(e), false);
});

test('client flow: valid token unlocks even after grace; fresh visitor makes no call and stays locked', async () => {
  let e = env({ isPremium: false, store: { glowgrid_entitlement: 'tok' }, now: () => Date.parse('2027-02-01T00:00:00Z'),
    fetch: () => Promise.resolve(jsonRes({ premium: true, enforce: true, graceUntil: GRACE })) });
  assert.strictEqual(await checkEntitlement(e), true);
  e = env({ isPremium: false });
  assert.strictEqual(await checkEntitlement(e), false);
  assert.strictEqual(e.calls.length, 0);
  e = env({ isPremium: true, sessionId: 'cs_live_x' });
  assert.strictEqual(await checkEntitlement(e), true); assert.strictEqual(e.calls.length, 0); // purchase-return path untouched
});

test('client flow: fails open on network error, 5xx, non-JSON, malformed body (even after grace)', async () => {
  const late = () => Date.parse('2027-06-01T00:00:00Z');
  for (const f of [
    () => Promise.reject(new Error('offline')),
    () => Promise.resolve({ json: () => Promise.reject(new SyntaxError('html 502')) }),
    () => Promise.resolve(jsonRes({ error: 'boom' })),
    () => Promise.resolve(jsonRes(null)),
    () => { throw new Error('sync throw'); },
  ]) {
    const e = env({ isPremium: true, now: late, fetch: f });
    let v; try { v = await checkEntitlement(e); } catch (x) { v = 'THREW'; }
    assert.strictEqual(v, true);
  }
});

test('token: wrong session id shape and expiry via injected clock', () => {
  const sec = 'q'.repeat(40);
  const t0 = Date.parse('2026-11-20T00:00:00Z');
  const t = issueToken(sec, 'cs_live_abc123', t0);
  // lifetime token: a one-time purchase must not silently expire (valid at +5y, expired only past +10y)
  assert.ok(verifyToken(sec, t, t0 + 365 * 86400000));
  assert.ok(verifyToken(sec, t, t0 + 5 * 365 * 86400000));
  assert.strictEqual(verifyToken(sec, t, t0 + 11 * 365 * 86400000), null);
  const [b] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ v: 1, sid: 'not-a-session', iat: 1, exp: 9999999999 })).toString('base64').replace(/=+$/, '');
  assert.strictEqual(verifyToken(sec, forged + '.' + t.split('.')[1], t0), null);
  assert.strictEqual(verifyToken(sec, issueToken(sec, 'bad session', t0), t0), null);
});

test('privacy page describes the signed token, not only glb_premium', () => {
  const p = fs.readFileSync(path.join(__dirname, '..', 'privacy.html'), 'utf8');
  assert.ok(/glowgrid_entitlement/.test(p) && /restore/.test(p));
});

// ---- restore path (mocked Stripe only; never a real call) ----
function loadRestore() {
  const m = html.match(/\/\/ RESTORE-BEGIN[^\n]*\n([\s\S]*?)\/\/ RESTORE-END/);
  assert.ok(m, 'RESTORE block present');
  return new Function('ENTITLEMENT_KEY', 'PREMIUM_KEY', 'LEGACY_PREMIUM_KEY', m[1] + '\nreturn { restorePurchase, shouldPromptRestore };')('glowgrid_entitlement', 'glowgrid_premium', 'glb_premium');
}
const { restorePurchase, shouldPromptRestore } = loadRestore();
const RENV = { STRIPE_READ_KEY: 'rk_test_x', PREMIUM_PAYMENT_LINKS: 'plink_ok', ENTITLEMENT_SECRET: 'r'.repeat(40) };
function freshRestore() { delete require.cache[require.resolve('../api/restore')]; return require('../api/restore'); }
const post = (email, ip) => ({ method: 'POST', body: { email }, headers: { 'x-forwarded-for': ip || '1.1.1.1' } });
function stripeMock(fn) { const calls = []; global.fetch = async (u, o) => { calls.push(u); assert.ok(u.startsWith('https://api.stripe.com/v1/checkout/sessions?'), 'read-only list call'); assert.ok(!o || !o.method || o.method === 'GET'); return fn(u); }; return calls; }

test('restore: paid purchase for the email returns a lifetime token bound to the session', async () => {
  const rs = freshRestore(); const real = global.fetch;
  const calls = stripeMock(() => ({ ok: true, json: async () => ({ data: [{ id: 'cs_live_paid1', status: 'complete', payment_status: 'paid', payment_link: 'plink_ok' }] }) }));
  try { await withEnv(RENV, async () => {
    const r = mockRes(); await rs(post('Buyer@Example.com'), r);
    assert.strictEqual(r.code, 200); assert.strictEqual(r.body.restored, true);
    const p = verifyToken(RENV.ENTITLEMENT_SECRET, r.body.token, Date.now() + 5 * 365 * 86400000);
    assert.strictEqual(p.sid, 'cs_live_paid1');
    assert.ok(calls[0].includes('customer_details[email]=') && !calls[0].includes('payment_link='));
  }); } finally { global.fetch = real; }
});
test('restore: no purchase, unpaid session, other link -> restored:false, no token', async () => {
  const rs = freshRestore(); const real = global.fetch;
  try { await withEnv(RENV, async () => {
    for (const data of [[], [{ id: 'cs_live_u', status: 'complete', payment_status: 'unpaid', payment_link: 'plink_ok' }], [{ id: 'cs_live_o', status: 'complete', payment_status: 'paid', payment_link: 'plink_other' }]]) {
      stripeMock(() => ({ ok: true, json: async () => ({ data }) }));
      const r = mockRes(); await rs(post('nobody@example.com', '2.2.2.' + data.length), r);
      assert.strictEqual(r.code, 200); assert.deepStrictEqual(r.body, { restored: false });
    }
  }); } finally { global.fetch = real; }
});
test('restore: malformed email, wrong method -> 4xx JSON, no Stripe call', async () => {
  const rs = freshRestore(); const real = global.fetch; let n = 0; global.fetch = async () => { n++; return { ok: true, json: async () => ({ data: [] }) }; };
  try { await withEnv(RENV, async () => {
    for (const e of ['', 'nope', 'a@b', 'a b@c.com', 123, null, 'x'.repeat(300) + '@e.com']) { const r = mockRes(); await rs(post(e, '3.3.3.3'), r); assert.strictEqual(r.code, 400); assert.strictEqual(r.body.restored, false); }
    let r = mockRes(); await rs({ method: 'GET', headers: {} }, r); assert.strictEqual(r.code, 405);
    r = mockRes(); await rs({ method: 'POST', body: 'not json{', headers: {} }, r); assert.strictEqual(r.code, 400);
    assert.strictEqual(n, 0);
  }); } finally { global.fetch = real; }
});
test('restore: rate limited per IP and per email (429), best-effort in-memory', async () => {
  const rs = freshRestore(); const real = global.fetch;
  stripeMock(() => ({ ok: true, json: async () => ({ data: [] }) }));
  try { await withEnv(RENV, async () => {
    let last; for (let i = 0; i < 9; i++) { last = mockRes(); await rs(post('u' + i + '@example.com', '4.4.4.4'), last); }
    assert.strictEqual(last.code, 429); assert.strictEqual(last.body.error, 'rate_limited');
    let r; for (let i = 0; i < 6; i++) { r = mockRes(); await rs(post('same@example.com', '5.5.5.' + i), r); }
    assert.strictEqual(r.code, 429);
  }); } finally { global.fetch = real; }
});
test('restore: Stripe error or missing config -> 5xx JSON restored:false (client treats as friendly error, never a lockout)', async () => {
  const rs = freshRestore(); const real = global.fetch;
  try { await withEnv(RENV, async () => {
    stripeMock(() => ({ ok: false, status: 500, json: async () => ({}) }));
    let r = mockRes(); await rs(post('a@example.com', '6.6.6.1'), r); assert.deepStrictEqual([r.code, r.body.restored], [502, false]);
    global.fetch = async () => { throw new Error('network'); };
    r = mockRes(); await rs(post('b@example.com', '6.6.6.2'), r); assert.deepStrictEqual([r.code, r.body.restored], [502, false]);
  }); await withEnv(Object.assign({}, RENV, { ENTITLEMENT_SECRET: undefined }), async () => {
    const r = mockRes(); await rs(post('c@example.com', '6.6.6.3'), r); assert.strictEqual(r.code, 503);
  }); } finally { global.fetch = real; }
});
test('restore never logs the email', async () => {
  const rs = freshRestore(); const real = global.fetch, log = console.log; const out = [];
  console.log = (...a) => out.push(a.join(' ')); stripeMock(() => ({ ok: true, json: async () => ({ data: [] }) }));
  try { await withEnv(RENV, async () => { await rs(post('secret.person@example.com', '7.7.7.7'), mockRes()); }); } finally { console.log = log; global.fetch = real; }
  assert.ok(out.length && out.every((l) => !/secret|example\.com|@/.test(l)));
});
test('client restore: states and prompt rules (mocked)', async () => {
  const f = (o) => () => Promise.resolve({ status: o.status || 200, json: () => Promise.resolve(o.body) });
  const base = 'x/';
  assert.deepStrictEqual(await restorePurchase({ base, fetch: f({ body: { restored: true, token: 'T' } }) }, 'a@b.co'), { state: 'restored', token: 'T' });
  assert.deepStrictEqual(await restorePurchase({ base, fetch: f({ body: { restored: false } }) }, 'a@b.co'), { state: 'none' });
  assert.deepStrictEqual(await restorePurchase({ base, fetch: f({ status: 429, body: { restored: false } }) }, 'a@b.co'), { state: 'error' });
  assert.deepStrictEqual(await restorePurchase({ base, fetch: f({ status: 502, body: { restored: false } }) }, 'a@b.co'), { state: 'error' });
  assert.deepStrictEqual(await restorePurchase({ base, fetch: () => Promise.reject(new Error('x')) }, 'a@b.co'), { state: 'error' });
  assert.deepStrictEqual(await restorePurchase({ base, fetch: f({ body: {} }) }, 'not-an-email'), { state: 'bad' });
  const e = (store, extra) => Object.assign({ sessionId: null, get: (k, d) => (k in store ? store[k] : d), now: () => 1e12 }, extra);
  assert.strictEqual(shouldPromptRestore(e({ glowgrid_premium: 'true' })), true);
  assert.strictEqual(shouldPromptRestore(e({ glb_premium: 'true' })), true);
  assert.strictEqual(shouldPromptRestore(e({})), false); // fresh browser: no prompt
  assert.strictEqual(shouldPromptRestore(e({ glowgrid_premium: 'true', glowgrid_entitlement: 't' })), false); // already has token
  assert.strictEqual(shouldPromptRestore(e({ glowgrid_premium: 'true', glowgrid_restore_dismissed: String(1e12 - 86400000) })), false); // dismissed
  assert.strictEqual(shouldPromptRestore(e({ glowgrid_premium: 'true', glowgrid_restore_dismissed: String(1e12 - 8 * 86400000) })), true);
});
test('privacy describes the restore check in one plain sentence', () => {
  const p = fs.readFileSync(path.join(__dirname, '..', 'privacy.html'), 'utf8');
  assert.match(p, /asks Stripe whether a paid purchase exists for the email you enter; the email is not stored/);
});

test('legal pages carry no unfilled-fact promises (governing law, venue, address)', () => {
  const bad = /will be stated|stated here|to be confirmed|\bTBD\b|\[CONFIRM|placeholder|governing law and venue/i;
  for (const f of ['terms.html', 'refunds.html', 'privacy.html']) {
    const t = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    const m = t.match(bad);
    assert.ok(!m, f + ' contains: ' + (m && m[0]));
  }
});

test('legal pages: skip link is the first focusable element and main has id="main" (R1119-HQ4-STUDIOS-55)', () => {
  for (const f of ['terms.html', 'refunds.html', 'privacy.html']) {
    const p = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    const body = p.slice(p.indexOf('<body>'));
    assert.match(body, /^<body>\s*<a class="skip" href="#main">Skip to main content<\/a>\s*<main id="main"/, f + ' skip link first');
    assert.match(p, /\.skip:focus-visible\{[^}]*outline:2px solid/, f + ' focus style');
  }
});
