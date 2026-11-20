// POST /api/restore { email }  ->  { restored: bool, token?: string }
// Restores a purchase made before signed tokens existed (or on another device): asks Stripe (read-only list call) whether a
// PAID Checkout session on one of our Payment Links exists for the typed email, and if so signs the same lifetime entitlement
// token verify-purchase issues. Env: STRIPE_READ_KEY, PREMIUM_PAYMENT_LINKS, ENTITLEMENT_SECRET.
// Privacy: no emails sent, nothing stored, the email is never logged (only a 8-char hash prefix).
// Rate limit is in-memory per serverless instance: BEST-EFFORT only (instances do not share it, cold starts reset it).
// Enumeration trade-off (honest): restored:true/false reveals whether an email has a Glowgrid purchase. Mitigations are the
// rate limit and returning a token only to the caller who typed the email; the response never says more than that.
const crypto = require('crypto');
const { issueToken } = require('./_entitlement');

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const WIN_MS = 10 * 60 * 1000, MAX_PER_IP = 8, MAX_PER_EMAIL = 5;
const hits = new Map(); // key -> [timestamps]
function limited(key, max, now) {
  const a = (hits.get(key) || []).filter((t) => now - t < WIN_MS);
  if (a.length >= max) { hits.set(key, a); return true; }
  a.push(now); hits.set(key, a);
  if (hits.size > 5000) { for (const [k, v] of hits) if (!v.some((t) => now - t < WIN_MS)) hits.delete(k); }
  return false;
}
const hashPrefix = (e) => crypto.createHash('sha256').update(e).digest('hex').slice(0, 8);

async function findPaidSession(key, links, email) {
  const variants = Array.from(new Set([email, email.toLowerCase()]));
  for (const link of links) {
    for (const em of variants) {
      const u = 'https://api.stripe.com/v1/checkout/sessions?limit=20&payment_link=' + encodeURIComponent(link) +
        '&customer_details[email]=' + encodeURIComponent(em);
      const r = await fetch(u, { headers: { Authorization: 'Bearer ' + key } });
      if (!r.ok) throw new Error('stripe_' + r.status);
      const j = await r.json();
      const s = ((j && j.data) || []).find((x) => x && x.status === 'complete' && x.payment_status === 'paid' && x.payment_link === link);
      if (s) return s.id;
    }
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ restored: false, error: 'method' }); }
  const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch (e) { return null; } })() : req.body;
  const email = body && typeof body.email === 'string' ? body.email.trim() : '';
  if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ restored: false, error: 'bad_email' });
  const now = Date.now();
  const ip = String((req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || 'unknown').split(',')[0].trim();
  const h = hashPrefix(email.toLowerCase());
  if (limited('ip:' + ip, MAX_PER_IP, now) || limited('em:' + h, MAX_PER_EMAIL, now)) {
    res.setHeader('Retry-After', '600');
    return res.status(429).json({ restored: false, error: 'rate_limited' });
  }
  const key = process.env.STRIPE_READ_KEY, secret = process.env.ENTITLEMENT_SECRET;
  const links = (process.env.PREMIUM_PAYMENT_LINKS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!key || !secret || links.length === 0) return res.status(503).json({ restored: false, error: 'unavailable' });
  try {
    const sid = await findPaidSession(key, links, email);
    if (!sid) { console.log('restore none ' + h); return res.status(200).json({ restored: false }); }
    const token = issueToken(secret, sid);
    if (!token) return res.status(503).json({ restored: false, error: 'unavailable' });
    console.log('restore ok ' + h);
    return res.status(200).json({ restored: true, token });
  } catch (e) {
    console.log('restore error ' + h);
    return res.status(502).json({ restored: false, error: 'unavailable' });
  }
};
module.exports._hits = hits;
