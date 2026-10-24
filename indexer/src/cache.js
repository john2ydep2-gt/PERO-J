'use strict';

/**
 * In-memory ABI LRU cache for the indexer.
 *
 * Entries are keyed by contract id and expire after a TTL. On top of the TTL,
 * entries can be evicted eagerly when the explorer contract emits an `update`
 * event (see `isExplorerUpdateEvent` / `evictContractMeta`).
 */

const DEFAULT_TTL_MS = 60 * 1000;
const DEFAULT_MAX_ENTRIES = 256;

class AbiLruCache {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.store = new Map();
  }

  get(contractId) {
    const entry = this.store.get(contractId);
    if (!entry) return undefined;

    if (Date.now() - entry.cachedAt >= this.ttlMs) {
      this.store.delete(contractId);
      return undefined;
    }

    // Refresh recency for LRU ordering.
    this.store.delete(contractId);
    this.store.set(contractId, entry);
    return entry.value;
  }

  set(contractId, value) {
    if (this.store.has(contractId)) {
      this.store.delete(contractId);
    }
    this.store.set(contractId, { value, cachedAt: Date.now() });

    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      this.store.delete(oldest);
    }

    return value;
  }

  evict(contractId) {
    return this.store.delete(contractId);
  }

  clear() {
    this.store.clear();
  }
}

const abiCache = new AbiLruCache();

/**
 * Detect an `update` event emitted by the explorer contract.
 *
 * @param {object} ev indexer event
 * @returns {boolean}
 */
function isExplorerUpdateEvent(ev) {
  if (!ev || typeof ev !== 'object') return false;

  const topic = ev.topic || ev.event || ev.name;
  if (topic !== 'update') return false;

  const contractId = ev.contractId || ev.contract || ev.source;
  if (!contractId) return false;

  const explorerContractId = ev.explorerContractId || process.env.EXPLORER_CONTRACT_ID;
  if (explorerContractId && contractId !== explorerContractId) return false;

  return true;
}

/**
 * Evict the cached ABI metadata for a contract so the next lookup re-fetches it.
 *
 * @param {string} contractId
 * @returns {boolean} whether an entry was removed
 */
function evictContractMeta(contractId) {
  if (!contractId) return false;
  return abiCache.evict(contractId);
}

/**
 * Handle an indexer event, evicting cached ABI metadata when the explorer
 * contract emits an `update` event.
 *
 * @param {object} ev indexer event
 * @returns {boolean} whether an eviction happened
 */
function handleIndexerEvent(ev) {
  if (!isExplorerUpdateEvent(ev)) return false;

  const contractId = ev.contractId || ev.contract || ev.source;
  return evictContractMeta(contractId);
}

/**
 * Invalidate Redis cache for a specific market ID.
 * 
 * This is called when oracle state changes (submission, dispute, finalization)
 * to ensure clients get fresh data within 5 seconds.
 * 
 * @param {string} marketId - Market identifier to invalidate
 * @returns {Promise<void>}
 */
async function invalidateMarketCache(marketId) {
  // If Redis client is available, invalidate cache entries for this market
  // For now, this is a placeholder - actual Redis integration would go here
  // when the project adds Redis caching for market data
  
  // Pattern examples that might need invalidation:
  // - `market:${marketId}`
  // - `market:${marketId}:oracle`
  // - `markets:list:*` (if there's a paginated markets list)
  
  if (process.env.REDIS_URL) {
    // TODO: When Redis is integrated, add actual cache invalidation here
    // const redis = require('./redis-client');
    // await redis.del(`market:${marketId}`);
    // await redis.del(`market:${marketId}:oracle`);
    console.log(`[cache] Would invalidate Redis cache for market: ${marketId}`);
  }
  
  // For now, this is effectively a no-op but provides the hook for future Redis integration
  return Promise.resolve();
}

module.exports = {
  AbiLruCache,
  abiCache,
  isExplorerUpdateEvent,
  evictContractMeta,
  handleIndexerEvent,
  invalidateMarketCache,
  DEFAULT_TTL_MS,
  DEFAULT_MAX_ENTRIES,
};
