<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

<!-- BEGIN:hedgescope -->

# HedgeScope (`/hedge`)

An options-monitoring surface living inside this app (shares its providers, cache,
AI client, UI kit and deploy pipeline — there is no second server). Code under
`src/lib/hedge/`, route at `src/app/hedge/`, API at `src/app/api/hedge/*`.

It is the **only** part of the app with durable state: SQLite on a named Docker
volume, holding the accumulated IV history. `docker system prune --volumes` used to
be harmless here. It is not any more.

## Read before changing the quant layer

Several things in here look like they could be simplified and cannot. Each was a
real bug, caught against live data:

- **Put-call parity tests against a forward implied from the chain**
  (`F = K + e^(rT)(C − P)`, median across the near-the-money strikes) — not
  `S·e^((r−q)T)`. Spot and the chain are fetched moments apart, and testing against
  a stale spot condemns healthy chains for clock drift. Do not "simplify" it to pick
  the ATM strike by smallest `|C − P|` either: a **dead penny strike** has
  `|C − P| ≈ 0` too, and choosing it made QQQ report a 765% implied dividend yield.
- **The surface keeps OTM contracts _plus_ a ±10% band around the forward.** A
  blanket "OTM only" rule sounds principled and destroys the ATM read on thin ETF
  chains, because it discards exactly the strikes adjacent to the forward. HYG, XLU
  and LQD all returned a null ATM IV — and therefore no VRP — under that rule.
- **Skew metrics read standard monthlies only.** Weeklies list far fewer strikes; a
  25-delta search on one silently clamps to the ladder edge and returns a
  wrong-but-plausible number.
- **Never extrapolate.** Delta-space and tenor interpolation both return `null`
  outside their data range. A clamped value is indistinguishable from a real one
  downstream, which is worse than an absent one.

## Data limits that are facts, not laziness

- Historical **implied vol** is free for exactly five tickers (SPY, QQQ, DIA, GLD,
  USO) via CBOE indices. The single-name ones are discontinued.
- Historical **skew** has no free source at all.
- Hence: `npm run hedge:scan` → `npm run hedge:backfill` → `npm run hedge:scan`.
  Skip the backfill and three of the five scanners correctly return nothing.

<!-- END:hedgescope -->
