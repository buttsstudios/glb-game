// Verifies an entitlement token issued by verify-purchase (HMAC, time-bound, bound to a paid session id).
// GET /api/entitlement?token=...  ->  { premium: bool, enforce: bool, graceUntil: ISO|null }
// Enforcement is OFF unless env GLOWGRID_ENFORCE_TOKEN=1. While OFF, the client keeps honouring the legacy
// localStorage flag exactly as before. While ON, the legacy flag unlocks only until GLOWGRID_LEGACY_GRACE_UNTIL
// (ISO date; if unset, no grace). Env: ENTITLEMENT_SECRET.
const { verifyToken } = require('./_entitlement');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.ENTITLEMENT_SECRET;
  const enforce = process.env.GLOWGRID_ENFORCE_TOKEN === '1';
  const g = process.env.GLOWGRID_LEGACY_GRACE_UNTIL || '';
  const graceUntil = g && !isNaN(Date.parse(g)) ? new Date(g).toISOString() : null;
  const token = String((req.query && req.query.token) || '');
  const p = token ? verifyToken(secret, token) : null;
  return res.status(200).json({ premium: !!p, enforce, graceUntil });
};
