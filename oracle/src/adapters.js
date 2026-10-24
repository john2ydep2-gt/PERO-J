/**
 * Data adapters. Each takes a market's `params` and returns a boolean outcome
 * (true = YES). Any fetch/parse failure throws so the submission is aborted.
 */

async function getJson(url, headers = {}) {
  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`${new URL(url).host} responded ${res.status}`);
  }
  return res.json();
}

function priceOutcome(price, { threshold, comparator = "gte" }) {
  if (!Number.isFinite(price)) {
    throw new Error("non-numeric price from data source");
  }
  return comparator === "lte"
    ? price <= Number(threshold)
    : price >= Number(threshold);
}

export const adapters = {
  async binance(params) {
    const data = await getJson(
      `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(params.symbol)}`,
    );
    return priceOutcome(Number(data.price), params);
  },

  async coinmarketcap(params) {
    const data = await getJson(
      `https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?symbol=${encodeURIComponent(params.cmc_symbol)}`,
      { "X-CMC_PRO_API_KEY": process.env.COINMARKETCAP_API_KEY ?? "" },
    );
    const entry = data?.data?.[params.cmc_symbol];
    const price = (Array.isArray(entry) ? entry[0] : entry)?.quote?.USD?.price;
    return priceOutcome(Number(price), params);
  },

  async oddsapi(params) {
    const data = await getJson(
      `https://api.the-odds-api.com/v4/sports/${encodeURIComponent(params.sport)}/scores/?daysFrom=3&apiKey=${process.env.ODDSAPI_API_KEY ?? ""}`,
    );
    const game = data.find((g) => g.id === params.event_id);
    if (!game?.completed) {
      throw new Error("event not completed");
    }
    const [a, b] = game.scores.map((s) => ({
      name: s.name,
      score: Number(s.score),
    }));
    return (a.score >= b.score ? a : b).name === params.winner;
  },
};

/** Market category -> adapters that must independently agree. */
export const categoryAdapters = {
  crypto: ["binance", "coinmarketcap"],
  sports: ["oddsapi"],
};
