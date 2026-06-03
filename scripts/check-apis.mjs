// Live API health-check. Reads .env / .env.local, makes one real call per
// configured provider, and prints pass/fail + latency. Never prints secrets.
//
//   node scripts/check-apis.mjs
//
// Exit code is 0 if every *configured* provider passed, 1 otherwise.

import { readFileSync } from "node:fs";

/** Load KEY=VALUE pairs from a dotenv file into process.env (no override). */
function loadEnvFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined && value !== "")
      process.env[key] = value;
  }
}

loadEnvFile(".env");
loadEnvFile(".env.local");

const results = [];

async function timed(fn) {
  const start = Date.now();
  try {
    const detail = await fn();
    return { ok: true, ms: Date.now() - start, detail };
  } catch (error) {
    return { ms: Date.now() - start, ok: false, detail: String(error) };
  }
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function check(name, configured, fn) {
  if (!configured) {
    results.push({ name, status: "SKIP", ms: 0, detail: "no key configured" });
    return;
  }
  const r = await timed(fn);
  results.push({
    name,
    status: r.ok ? "PASS" : "FAIL",
    ms: r.ms,
    detail: r.detail,
  });
}

const env = process.env;

await check("FMP /stable/profile", Boolean(env.FMP_API_KEY), async () => {
  const res = await fetchWithTimeout(
    `https://financialmodelingprep.com/stable/profile?symbol=AAPL&apikey=${env.FMP_API_KEY}`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const price = Array.isArray(data) ? data[0]?.price : undefined;
  return `price=${price}`;
});

await check("FMP /stable/ratios-ttm", Boolean(env.FMP_API_KEY), async () => {
  const res = await fetchWithTimeout(
    `https://financialmodelingprep.com/stable/ratios-ttm?symbol=AAPL&apikey=${env.FMP_API_KEY}`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} (likely a paid endpoint)`);
  const data = await res.json();
  const pe = Array.isArray(data)
    ? (data[0]?.priceToEarningsRatioTTM ?? data[0]?.peRatioTTM)
    : undefined;
  return `peTTM=${pe}`;
});

await check("CoinGecko /coins/markets", true, async () => {
  const headers = env.COINGECKO_API_KEY
    ? { "x-cg-demo-api-key": env.COINGECKO_API_KEY }
    : undefined;
  const res = await fetchWithTimeout(
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin",
    { headers },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return `btc=$${data?.[0]?.current_price}`;
});

await check(
  "FRED /series/observations",
  Boolean(env.FRED_API_KEY),
  async () => {
    const res = await fetchWithTimeout(
      `https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key=${env.FRED_API_KEY}&file_type=json&sort_order=desc&limit=1`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return `US10Y=${data?.observations?.[0]?.value}`;
  },
);

await check("Yahoo Finance (yahoo-finance2)", true, async () => {
  const { default: YahooFinance } = await import("yahoo-finance2");
  const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
  const q = await yf.quote("^GSPC");
  return `^GSPC=${q?.regularMarketPrice}`;
});

await check(
  "OpenRouter chat/completions",
  Boolean(env.OPENROUTER_API_KEY),
  async () => {
    const model = env.OPENROUTER_MODEL || "anthropic/claude-3.5-haiku";
    const res = await fetchWithTimeout(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 10,
          messages: [{ role: "user", content: "Reply with the word OK." }],
        }),
      },
    );
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
    return `model=${model} ok`;
  },
);

await check("Binance order book", true, async () => {
  const res = await fetchWithTimeout(
    "https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=5",
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return `topBid=${data?.bids?.[0]?.[0]} topAsk=${data?.asks?.[0]?.[0]}`;
});

await check("Yahoo options (yahoo-finance2)", true, async () => {
  const { default: YahooFinance } = await import("yahoo-finance2");
  const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
  const o = await yf.options("AAPL");
  return `expirations=${(o.expirationDates || []).length} calls=${(o.options?.[0]?.calls || []).length}`;
});

await check("Finnhub /company-news", Boolean(env.FINNHUB_API_KEY), async () => {
  const to = "2024-12-31";
  const from = "2024-12-01";
  const res = await fetchWithTimeout(
    `https://finnhub.io/api/v1/company-news?symbol=AAPL&from=${from}&to=${to}&token=${env.FINNHUB_API_KEY}`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return `${Array.isArray(data) ? data.length : 0} articles`;
});

const pad = (s, n) => String(s).padEnd(n);
let failed = 0;
process.stdout.write("\nAPI health check\n================\n");
for (const r of results) {
  if (r.status === "FAIL") failed += 1;
  process.stdout.write(
    `${pad(r.status, 5)} ${pad(r.name, 32)} ${pad(`${r.ms}ms`, 8)} ${r.detail}\n`,
  );
}
process.stdout.write(
  `\n${failed === 0 ? "All configured checks passed." : `${failed} check(s) failed.`}\n`,
);
process.exit(failed === 0 ? 0 : 1);
