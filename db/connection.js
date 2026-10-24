import pg from "pg";

/**
 * @typedef {"backend" | "indexer"} ServiceType
 *
 * @typedef {Object} PoolMetrics
 * @property {number} totalCount
 * @property {number} idleCount
 * @property {number} waitingCount
 * @property {number} max
 * @property {boolean} isHealthy
 */

/**
 * Returns tuned connection pool configuration based on service type.
 *
 * Backend services default to `max: 25` to support concurrent API requests.
 * Indexer services default to `max: 10` to avoid overwhelming Postgres while streaming blocks.
 *
 * Both services use:
 * - `idleTimeoutMillis: 30000` (cleanly reaps idle connections after 30s)
 * - `connectionTimeoutMillis: 5000` (fast failure on exhaustion rather than hanging)
 *
 * @param {ServiceType} [serviceType="backend"]
 * @param {import("pg").PoolConfig} [overrides={}]
 * @returns {import("pg").PoolConfig}
 */
export function getPoolConfig(serviceType = "backend", overrides = {}) {
  const defaultMax = serviceType === "backend" ? 25 : 10;
  const envPoolSize = process.env.DATABASE_POOL_SIZE
    ? Number(process.env.DATABASE_POOL_SIZE)
    : undefined;

  const max =
    overrides.max ??
    (envPoolSize && !Number.isNaN(envPoolSize) ? envPoolSize : defaultMax);

  return {
    connectionString: overrides.connectionString ?? process.env.DATABASE_URL,
    max,
    idleTimeoutMillis: overrides.idleTimeoutMillis ?? 30000,
    connectionTimeoutMillis: overrides.connectionTimeoutMillis ?? 5000,
    ...overrides,
  };
}

/**
 * Creates and tunes a pg.Pool instance with error handlers and connection recycling.
 *
 * @param {ServiceType} [serviceType="backend"]
 * @param {import("pg").PoolConfig} [options={}]
 * @returns {import("pg").Pool}
 */
export function createConnectionPool(serviceType = "backend", options = {}) {
  const config = getPoolConfig(serviceType, options);
  const pool = new pg.Pool(config);

  // Error event handler: prevents unhandled errors on idle clients from crashing the process
  pool.on("error", (err) => {
    console.error(`[db-pool:${serviceType}] Unexpected error on idle client:`, err);
  });

  return pool;
}

/**
 * Retrieves current pool health and utilization metrics.
 *
 * @param {import("pg").Pool} pool
 * @param {number} [configuredMax]
 * @returns {PoolMetrics}
 */
export function getPoolMetrics(pool, configuredMax) {
  const totalCount = pool.totalCount ?? 0;
  const idleCount = pool.idleCount ?? 0;
  const waitingCount = pool.waitingCount ?? 0;
  const max = configuredMax ?? (pool.options?.max ?? 20);

  // Health check: pool is degraded if queries are queuing while pool is saturated
  const isHealthy = !(waitingCount > 0 && totalCount >= max);

  return {
    totalCount,
    idleCount,
    waitingCount,
    max,
    isHealthy,
  };
}

export default createConnectionPool;
