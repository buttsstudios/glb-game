// Vercel Node function: confirms a Stripe Checkout session (Payment Link redirect) was paid.
// Replaces the old `?premium=true` URL flag, which unlocked premium without paying.
// Env: STRIPE_READ_KEY (restricted, Checkout Sessions read), PREMIUM_PAYMENT_LINKS (comma list of plink_ ids).
// Payment Link "after payment" redirect: https://buttsstudios.com/games/glowgrid?session_id={CHECKOUT_SESSION_ID} (served by the site proxy at /games/glowgrid)
module.exports = async (req, res) => {
  const id = String((req.query && req.query.session_id) || '');
  res.setHeader('Cache-Control', 'no-store');
  if (!/^cs_(live|test)_[A-Za-z0-9]+$/.test(id)) return res.status(400).json({ premium: false, error: 'bad_session' });
  const key = process.env.STRIPE_READ_KEY;
  const allowed = (process.env.PREMIUM_PAYMENT_LINKS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!key || allowed.length === 0) return res.status(503).json({ premium: false, error: 'not_configured' });
  const r = await fetch('https://api.stripe.com/v1/checkout/sessions/' + id, { headers: { Authorization: 'Bearer ' + key } });
  if (!r.ok) return res.status(404).json({ premium: false });
  const s = await r.json();
  const ok = s.status === 'complete' && s.payment_status === 'paid' && allowed.includes(s.payment_link);
  return res.status(ok ? 200 : 402).json({ premium: ok });
};
