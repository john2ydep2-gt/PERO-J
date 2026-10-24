import pg, { Pool, PoolConfig } from "pg";

export type ServiceType = "backend" | "indexer";

export interface PoolMetrics {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  max: number;
  isHealthy: boolean;
}

export interface TunedPoolOptions extends Partial<PoolConfig> {
  serviceType?: ServiceType;
}

/**
 * Returns tuned connection pool configuration based on service type.
 *
 * Backend services default to `max: 25` to support concurrent API requests.
 * Indexer services default to `max: 10` to avoid overwhelming Postgres while streaming blocks.
 *
 * Both services use:
 * - `idleTimeoutMillis: 30000` (cleanly reaps idle connections after 30s)
 * - `connectionTimeoutMillis: 5000` (fast failure on exhaustion rather than hanging)
 */
export function getPoolConfig(
  serviceType: ServiceType = "backend",
  overrides: TunedPoolOptions = {}
): PoolConfig {
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
 */
export function createConnectionPool(
  serviceType: ServiceType = "backend",
  options: TunedPoolOptions = {}
): Pool {
  const config = getPoolConfig(serviceType, options);
  const pool = new pg.Pool(config);

  // Error event handler: prevents unhandled errors on idle clients from crashing the process
  pool.on("error", (err: Error) => {
    console.error(`[db-pool:${serviceType}] Unexpected error on idle client:`, err);
  });

  return pool;
}

/**
 * Retrieves current pool health and utilization metrics.
 */
export function getPoolMetrics(pool: Pool, configuredMax?: number): PoolMetrics {
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
