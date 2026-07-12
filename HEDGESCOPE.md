# HedgeScope — operator's brief

What it is, what each number means, and what to trust right now. For the code
invariants, see `AGENTS.md`; for the deploy, `README.md`.

## What it does

Scans ~85 tickers twice a day (10:00 and 15:30 ET, weekdays) for option-based
hedging setups. It pulls the full option chain, cleans it, computes a volatility
surface, and ranks five kinds of setup. It lives at `/hedge` inside the existing
dashboard — same server, same cache, same deploy.

Live since 2026-07-12.

## The five scanners

| Scanner          | Buys or sells                 | Fires when                                       |
| ---------------- | ----------------------------- | ------------------------------------------------ |
| Protective put   | Buys downside                 | IVR low — protection is cheap                    |
| Put debit spread | Buys downside, sells the wing | Put skew rich vs its own history                 |
| Call credit      | Sells upside                  | IVR high and price stretched above trend         |
| Collar           | Buys a put, sells a call      | Calls priced above puts in vol terms             |
| Tail hedge       | Buys far-OTM convexity        | Credit deteriorating while equity vol stays calm |

IVR = implied-volatility rank. OTM = out-of-the-money.

## The numbers, and which to trust today

**VRP (variance risk premium)** — implied volatility minus forecast realized
volatility, in vol points. Positive means options are expensive relative to how
much the underlying is actually moving. **This is the signal to trust this week:**
it needs no stored history, only today's chain and the price candles, so it is
honest from the first scan.

**IVR (implied-volatility rank)** — where today's IV sits inside its trailing
252-day range, 0 to 100. Needs accumulated history, so right now it is **flagged
`proxied` on 80 of the 85 tickers** and computed from realized-volatility rank
instead. That is not a bug and not a fallback failure: historical implied vol is
free for exactly five tickers (SPY, QQQ, DIA, GLD, USO, via the CBOE indices) and
is a paid product for everything else. The proxy is labelled as such everywhere it
appears. Real IVR unlocks per ticker once it has 60 real observations — roughly
three months of twice-daily scans, accumulating on its own from now on.

**Skew (25-delta)** — the price of the downside wing against the body. Read from
standard monthly expiries only, because weeklies list too few strikes for a
25-delta search to be meaningful.

**Term structure** — the slope of IV across expiries.

## The data-quality badge

Each ticker's chain is graded `good` / `degraded` / `poor`. It answers exactly one
question: **is this chain stale?**

Every call/put pair is tested against put-call parity — an arbitrage identity that
holds in any live market regardless of any volatility model. A pair that violates
it has a stale leg, and an IV solved from a stale quote is _wrong_, not merely
noisy, so it is excluded from every metric. The exclusion rate becomes the badge.

Dead tails do not count against the grade. A penny wing carries no recoverable
volatility either way, and a chain is not stale merely for having wings nobody
trades.

**A `degraded` badge means the informative part of the chain is genuinely stale —
treat that ticker's numbers with suspicion.** As of the 2026-07-12 measurement,
HYG and XLU are the two that earn it.

## Known quirks, so they don't read as bugs

- **Collar scores are negative across the board.** Equities carry a persistent put
  skew, so puts cost more than calls. Ranking still works — highest is least bad —
  but the sign looks odd.
- **XLU shows a negative 25-delta put skew (−3.30).** A reverse skew is unusual for
  a utility ETF. Its chain is the worst of the eight measured — 45% of pairs fail
  parity, median last trade 232 days old — so treat it as a likely artefact of a
  stale chain rather than a market view. Open item.
- **AI notes are optional.** With no OpenRouter key the dashboard falls back to
  deterministic notes built from the same computed numbers. It stays useful with AI
  switched off.

## The one operational rule

The SQLite database on the `hedge-data` Docker volume is the only durable state in
the stack, and it holds the accumulated IV history — 252 days of it, with no
upstream to re-download from.

`docker compose down -v` and `docker system prune --volumes` **destroy it**, and
the history restarts at zero. `docker image prune -f` is safe.
