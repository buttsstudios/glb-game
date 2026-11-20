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
  assert.strictEqual(verifyToken(sec, issueToken(sec, SID, Date.now() - 400 * 86400e3)), null);
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
  assert.ok(verifyToken(sec, t, t0 + 364 * 86400000));
  assert.strictEqual(verifyToken(sec, t, t0 + 366 * 86400000), null);
  const [b] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ v: 1, sid: 'not-a-session', iat: 1, exp: 9999999999 })).toString('base64').replace(/=+$/, '');
  assert.strictEqual(verifyToken(sec, forged + '.' + t.split('.')[1], t0), null);
  assert.strictEqual(verifyToken(sec, issueToken(sec, 'bad session', t0), t0), null);
});

test('privacy page describes the signed token, not only glb_premium', () => {
  const p = fs.readFileSync(path.join(__dirname, '..', 'privacy.html'), 'utf8');
  assert.ok(/glowgrid_entitlement/.test(p) && /restore/.test(p));
});
