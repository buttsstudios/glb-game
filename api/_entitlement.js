// Stateless entitlement token: HMAC-SHA256 over a small JSON payload bound to a verified Stripe Checkout session id.
// Env: ENTITLEMENT_SECRET (server only, 32+ random chars). No database, no accounts.
// Threat model (honest): this closes "type glowgrid_premium=true into localStorage". It does not stop a buyer
// sharing a token, and because the game logic runs in the browser it cannot stop someone patching their own copy
// of the page; it makes the unlock require a server-signed proof tied to a real paid Stripe session.
const crypto = require('crypto');

const TOKEN_DAYS = 365;
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function sign(secret, body) {
  return b64u(crypto.createHmac('sha256', secret).update(body).digest());
}

function issueToken(secret, sessionId, nowMs, days) {
  if (!secret) return null;
  const iat = Math.floor((nowMs || Date.now()) / 1000);
  const exp = iat + 86400 * (days || TOKEN_DAYS);
  const body = b64u(JSON.stringify({ v: 1, sid: sessionId, iat, exp }));
  return body + '.' + sign(secret, body);
}

// Returns the payload when the signature is valid and not expired, else null.
function verifyToken(secret, token, nowMs) {
  if (!secret || typeof token !== 'string' || token.length > 600) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const want = Buffer.from(sign(secret, parts[0]));
  const got = Buffer.from(parts[1]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  let p;
  try { p = JSON.parse(unb64u(parts[0]).toString('utf8')); } catch (e) { return null; }
  if (!p || p.v !== 1 || !/^cs_(live|test)_[A-Za-z0-9]+$/.test(String(p.sid))) return null;
  if (!(p.exp > Math.floor((nowMs || Date.now()) / 1000))) return null;
  return p;
}

module.exports = { issueToken, verifyToken, TOKEN_DAYS };
