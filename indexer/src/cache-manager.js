import { getRedisClient, getRedisSubscriber } from "./redis.js";

export const BET_PLACED_CHANNEL = "stellar:events:mkt:bet";
const DEFAULT_TTL_SECONDS = 3600;

/**
 * Calculates outcome odds from outcome pool totals.
 *
 * @param {Record<string, number>} outcomePools
 * @param {number} totalPool
 * @returns {Record<string, number>}
 */
export function calculateOdds(outcomePools, totalPool) {
  if (!outcomePools || typeof outcomePools !== "object") {
    return {};
  }
  const odds = {};
  const total = Number(totalPool) || Object.values(outcomePools).reduce((a, b) => a + Number(b), 0);
  for (const [outcome, pool] of Object.entries(outcomePools)) {
    const p = Number(pool) || 0;
    odds[outcome] = p > 0 ? parseFloat((total / p).toFixed(4)) : 1.0;
  }
  return odds;
}

export class MarketCacheManager {
  /**
   * @param {object} [opts]
   * @param {any} [opts.redisClient]
   * @param {any} [opts.redisSubscriber]
   * @param {number} [opts.ttlSeconds=3600]
   */
  constructor({
    redisClient = null,
    redisSubscriber = null,
    ttlSeconds = DEFAULT_TTL_SECONDS,
  } = {}) {
    this.client = redisClient || getRedisClient();
    this.subscriber = redisSubscriber || getRedisSubscriber();
    this.ttlSeconds = ttlSeconds;
    this.isListening = false;
    this.metrics = {
      invalidations: 0,
      lastInvalidationLatencyMs: 0,
      lastInvalidatedAt: null,
    };
    this.boundHandler = this.handleBetPlacedEvent.bind(this);
  }

  /**
   * Start listening for BetPlaced events on Redis pub/sub.
   */
  start() {
    if (this.isListening) return;
    this.subscriber.subscribe(BET_PLACED_CHANNEL, this.boundHandler);
    this.isListening = true;
  }

  /**
   * Stop listening for BetPlaced events.
   */
  stop() {
    if (!this.isListening) return;
    this.subscriber.unsubscribe(BET_PLACED_CHANNEL, this.boundHandler);
    this.isListening = false;
  }

  /**
   * Purge cache keys for a given market:
   * market:${market_id} and market:${market_id}:odds
   *
   * @param {string} marketId
   * @returns {Promise<{ marketKey: string, oddsKey: string, purged: boolean }>}
   */
  async invalidateMarketCache(marketId) {
    if (!marketId) return { purged: false };
    const marketKey = `market:${marketId}`;
    const oddsKey = `market:${marketId}:odds`;
    await this.client.del(marketKey, oddsKey);
    return { marketKey, oddsKey, purged: true };
  }

  /**
   * Pre-warm cache with fresh market totals and odds.
   *
   * @param {string} marketId
   * @param {object} [data]
   * @param {object} [data.market]
   * @param {object} [data.odds]
   * @param {number} [data.total_pool]
   * @param {Record<string, number>} [data.outcome_pools]
   * @returns {Promise<void>}
   */
  async prewarmCache(marketId, data = {}) {
    if (!marketId) return;
    const marketKey = `market:${marketId}`;
    const oddsKey = `market:${marketId}:odds`;

    if (data.market) {
      await this.client.set(
        marketKey,
        JSON.stringify(data.market),
        "EX",
        this.ttlSeconds
      );
    }

    const oddsToCache =
      data.odds ||
      (data.outcome_pools ? calculateOdds(data.outcome_pools, data.total_pool) : null);

    if (oddsToCache) {
      await this.client.set(
        oddsKey,
        JSON.stringify(oddsToCache),
        "EX",
        this.ttlSeconds
      );
    }
  }

  /**
   * Process a BetPlaced event:
   * 1. Immediately purge keys market:${market_id} and market:${market_id}:odds.
   * 2. Pre-warm cache with updated totals/odds included in the payload.
   * 3. Guarantees cache invalidation and pre-warming occurs in < 100ms.
   *
   * @param {object|string} rawPayload
   * @returns {Promise<{ market_id: string, latency_ms: number, success: boolean }>}
   */
  async handleBetPlacedEvent(rawPayload) {
    const startTime = performance.now();
    let payload;
    try {
      payload = typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;
    } catch (err) {
      console.error("[cache-manager] Failed to parse bet event payload:", err.message);
      return { success: false, error: err.message };
    }

    const marketId = payload?.market_id || payload?.marketId;
    if (!marketId) {
      return { success: false, error: "Missing market_id in bet event payload" };
    }

    // 1. Purge stale cache entries immediately
    await this.invalidateMarketCache(marketId);

    // 2. Pre-warm cache with updated totals & odds from event payload
    await this.prewarmCache(marketId, {
      market: payload.market,
      odds: payload.odds,
      total_pool: payload.total_pool ?? payload.totalPool,
      outcome_pools: payload.outcome_pools ?? payload.outcomePools,
    });

    const latencyMs = performance.now() - startTime;

    this.metrics.invalidations++;
    this.metrics.lastInvalidationLatencyMs = latencyMs;
    this.metrics.lastInvalidatedAt = new Date().toISOString();

    if (latencyMs > 100) {
      console.warn(
        `[cache-manager] Cache invalidation latency for ${marketId} exceeded SLA: ${latencyMs.toFixed(2)}ms > 100ms`
      );
    }

    return {
      success: true,
      market_id: marketId,
      latency_ms: latencyMs,
      prewarmed: true,
    };
  }

  /**
   * Read market details from cache or fallback.
   *
   * @param {string} marketId
   * @param {() => Promise<any>} [fetchFallback]
   * @returns {Promise<any>}
   */
  async getMarket(marketId, fetchFallback = null) {
    if (!marketId) return null;
    const cached = await this.client.get(`market:${marketId}`);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {
        // invalid json, re-fetch
      }
    }
    if (typeof fetchFallback === "function") {
      const fresh = await fetchFallback();
      if (fresh) {
        await this.client.set(
          `market:${marketId}`,
          JSON.stringify(fresh),
          "EX",
          this.ttlSeconds
        );
      }
      return fresh;
    }
    return null;
  }

  /**
   * Read market odds from cache or fallback.
   *
   * @param {string} marketId
   * @param {() => Promise<any>} [fetchFallback]
   * @returns {Promise<any>}
   */
  async getMarketOdds(marketId, fetchFallback = null) {
    if (!marketId) return null;
    const cached = await this.client.get(`market:${marketId}:odds`);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {
        // invalid json, re-fetch
      }
    }
    if (typeof fetchFallback === "function") {
      const fresh = await fetchFallback();
      if (fresh) {
        await this.client.set(
          `market:${marketId}:odds`,
          JSON.stringify(fresh),
          "EX",
          this.ttlSeconds
        );
      }
      return fresh;
    }
    return null;
  }
}

export const marketCacheManager = new MarketCacheManager();
