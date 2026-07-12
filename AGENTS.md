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

**Live in production since 2026-07-12.** The scheduler scans twice a day, so the IV
history now accumulates on its own. Two things the deploy needs that git does not
carry: `HEDGE_SCAN_SECRET` in the server's `.env` (without it both the scan and
backfill endpoints fail closed with a 404 — deliberately, since they fire hundreds of
Yahoo requests), and the bootstrap order below, run once against the empty database.

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
- **A parity violation is only a _defect_ if the contract was informative.** In
  `usable()`, each contract is screened on its own quote _before_ parity decides how
  to book it. A dead penny wing that fails parity is counted illiquid, not bad data:
  no vol was recoverable from it, the spread/vega screens would have dropped it
  anyway, and a chain is not stale merely for having tails. Testing parity first
  applied two standards to the identical worthless contract and badged every thin
  ETF `degraded`. It is still **excluded from every metric** either way — only the
  grading changes.
- **Never tune `metrics.parity.tolerance` / `halfSpreadMult` to make the badge go
  green.** That cannot tell "too strict" from "genuinely stale", and loosening
  readmits the poison. Measure first — `tests/diagnostics/parity.probe.ts` dumps the
  violation magnitudes against the thresholds on a live chain, with each contract's
  last-trade age and open interest beside them. Run it before touching either number.
  Last run (2026-07-12, ~3k pairs): rejects miss by a **median 13× the threshold**,
  last traded a median **101 days** ago, median open interest **zero**. The threshold
  is not too tight; it is catching dead contracts.
- **Skew metrics read standard monthlies only.** Weeklies list far fewer strikes; a
  25-delta search on one silently clamps to the ladder edge and returns a
  wrong-but-plausible number.
- **Never extrapolate.** Delta-space and tenor interpolation both return `null`
  outside their data range. A clamped value is indistinguishable from a real one
  downstream, which is worse than an absent one.
- **In `upsertHistory`, the `atm_iv_proxied` / `atm_iv_basis` flags travel with the
  value.** They are adopted only when the incoming row actually brings an ATM IV.
  Stamping them unconditionally let a backfill row (`atm_iv = NULL`) keep a real
  observation's value while relabelling it a proxy — so re-running a backfill after
  months of scans silently erased the real IV history of every ticker without a CBOE
  index.
- **IV is always solved from the bid/ask mid**, never Yahoo's `impliedVolatility`
  field, which is derived from a stale `lastPrice` (a live pull showed a 2-DTE
  near-ATM SPY call quoting 5.5% IV).

## Data limits that are facts, not laziness

- Historical **implied vol** is free for exactly five tickers (SPY, QQQ, DIA, GLD,
  USO) via CBOE indices. The single-name ones are discontinued.
- Historical **skew** has no free source at all.
- Hence: `npm run hedge:scan` → `npm run hedge:backfill` → `npm run hedge:scan`.
  Skip the backfill and three of the five scanners correctly return nothing.

<!-- END:hedgescope -->
