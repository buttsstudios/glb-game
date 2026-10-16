# Glowgrid (formerly "GLB") — design

Branch `design/next-level-2026-10-16` (built on `style/studios-sections-2026-10-16`, which carries the verified-purchase fix and the $5 price branch). Nothing deployed.

## Rename
Principal 2026-10-16: the game has nothing to do with Girls Love Butts, so it is renamed.

| Candidate | Why |
|---|---|
| **Glowgrid** (picked) | Says what you see: light on a grid. Short, ownable, reads cleanly next to the Studios mark, and works as a subdomain. |
| Firefly Run | Playful and warm, but "Firefly" is crowded (TV, Adobe). |
| Spark Catch | Clear verb, but generic and harder to own. |

Applied: page title, bar label (`Butts Studios / Games / Glowgrid`), meta/OG/Twitter, manifest, OG template, paywall and restore copy, storage keys, and the code comment naming the Stripe product display text.
Kept on purpose: repo path `games/glb`, the `glb.buttsstudios.com` subdomain, the `__NEW_PAYMENT_LINK_GLB_5__` placeholder (the staged GO script fills it), and a read-only check of the legacy `glb_premium` key so earlier buyers keep their unlock.

**Staged for the Principal:** add `glowgrid.buttsstudios.com` in Vercel + DNS, 301 `glb.buttsstudios.com/*` to it, point the Payment Link redirect to `https://glowgrid.buttsstudios.com/?session_id={CHECKOUT_SESSION_ID}`, rename the Stripe product to "Glowgrid: full game", and update `site/games.html` (name, kind, logline). Then swap the canonical/OG URLs in `index.html`.

## Teardown (before)
- **It did not run.** Since commit `59e0d5f` (paywall) the `player`, `keys`, `orbs`, `obstacles` declarations were missing; Start threw `orbs is not defined`. This is also the live state (`glb.buttsstudios.com`).
- Core loop (collect orbs, dodge bouncers) was sound but flat: random spawns, no route, no reason to move fast.
- Feel: instant start/stop movement, frame-rate-dependent speed, a teleport to centre on every hit (often into another hazard).
- Pacing/difficulty: random orbs + random hazards, which could spawn on the player. No ramp beyond counts.
- Onboarding: one grey line under the canvas. No pause.
- Feedback: none on pickup or hit besides a number.
- Progression/replay: none. No best score, no reason to come back.
- Accessibility: red vs green circles only (colour-only), no announcements, no reduced-motion handling.
- Mobile: fixed 800px canvas overflowed a 390px screen; keyboard-only controls.

## What changed (after)
- **Core loop:** light comes in named patterns (First light, The line, Ring, Crossroads, Spiral; then Zigzag, Twin rings, Corners, Scatter). The pattern suggests a route; static cuts across it.
- **Chain:** pickups within 1.4 s chain up to x8. A speed bonus rewards clearing under par (2.2 s per light). Fast, planned routes score best.
- **Hazards ramp:** drifting static (count and speed by level), a purple chaser from level 4, pulsing static from level 6. Static never spawns within 190 px of you and is harmless while the level title shows.
- **Feel:** acceleration + drag movement, delta-time physics, knockback and 1.6 s blink on a hit instead of a teleport, screen shake (skipped under reduced motion), particle bursts, floating score text, rising-pitch pickup tones, a three-note clear chime. Mute with M or the button.
- **The trail:** your light leaves a tapered additive trail; the whole run is recorded and drawn as a **share card** (1200×630 PNG with score, level, lights, hits). Share uses the native share sheet with the image where supported, otherwise saves the PNG and copies the score text.
- **Today's run:** five levels seeded by the local date, so everyone gets the same board each day. Its best is kept per day. Available to everyone (it stays inside the five-level trial).
- **Endless:** five levels to try; the full game ($5, one-time, unlocks in this browser) opens every level after that. The unlock still needs a server-verified paid Stripe session (`/api/verify-purchase`).
- **Onboarding:** an attract-mode board behind the menu, two clear modes, controls on screen, a short legend under the board.
- **Accessibility:** hazards are squares with an X, light is circles (shape, not colour), aria-live announcements for level, hits and results, visible focus, reduced-motion support, auto-pause when the tab hides.
- **Mobile:** responsive HiDPI canvas (4:3, scales to width), drag-to-steer, overlays fit a 390px screen with no horizontal scroll.
- **Studios visual pass:** display headline (Archivo 800, tight leading) with eyebrow and Newsreader lede as on buttsstudios.com, HUD as a ruled strip, display-type panels with serif body, plate-style foot line, new OG card. Shared bar/footer untouched; section accent (phosphor green), 2px corners, full even borders.

## Playtest (xps, headless Chromium)
Bot run, desktop 1280: Today's run completed all 5 levels (9,548, 2 hits). Endless reached the level-5 trial gate and showed the paywall. Mobile 390: no page errors, `scrollWidth` 390. Shots + `after_play.gif`: `~/buttsstudios/staged/games_next_level/glb/`. Before: Start threw `orbs is not defined`; the 800px canvas overflowed mobile.

## Next
- A second daily ("hard" seed) and a weekly board need a server; the leaderboard is out of scope until then.
- New icons at 192/512 for the manifest.
