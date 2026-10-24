import { Pool, PoolClient, PoolConfig } from "pg";

const MIGRATION_LOCK_ID = 836;

export type ServiceType = "backend" | "indexer";

export interface PoolMetrics {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  max: number;
  isHealthy: boolean;
}

export class Database {
  private pool: Pool;
  private maxConnections: number;

  constructor(
    connectionString: string,
    serviceType: ServiceType = "indexer",
    customOptions: Partial<PoolConfig> = {}
  ) {
    const defaultMax = serviceType === "backend" ? 25 : 10;
    const envPoolSize = process.env.DATABASE_POOL_SIZE
      ? Number(process.env.DATABASE_POOL_SIZE)
      : undefined;

    this.maxConnections =
      customOptions.max ??
      (envPoolSize && !Number.isNaN(envPoolSize) ? envPoolSize : defaultMax);

    this.pool = new Pool({
      connectionString,
      max: this.maxConnections,
      idleTimeoutMillis: customOptions.idleTimeoutMillis ?? 30000,
      connectionTimeoutMillis: customOptions.connectionTimeoutMillis ?? 5000,
      ...customOptions,
    });

    // Error event handler: prevent idle connection drops from crashing the service
    this.pool.on("error", (err: Error) => {
      console.error(`[db-pool:${serviceType}] Unexpected error on idle client:`, err);
    });
  }

  getPool(): Pool {
    return this.pool;
  }

  getPoolMetrics(): PoolMetrics {
    const totalCount = this.pool.totalCount ?? 0;
    const idleCount = this.pool.idleCount ?? 0;
    const waitingCount = this.pool.waitingCount ?? 0;
    const isHealthy = !(waitingCount > 0 && totalCount >= this.maxConnections);

    return {
      totalCount,
      idleCount,
      waitingCount,
      max: this.maxConnections,
      isHealthy,
    };
  }

  async init(): Promise<void> {
    const client = await this.pool.connect();
    let locked = false;
    try {
      await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
      locked = true;

      await client.query("BEGIN");
      try {
        await this.runMigrations(client);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    } finally {
      if (locked) {
        try {
          await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
        } catch (unlockErr) {
          console.error("Failed to release migration advisory lock:", unlockErr);
        }
      }
      client.release();
    }
  }

  private async runMigrations(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS contracts (
        id TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS dlq_events (
        id SERIAL PRIMARY KEY,
        ledger_sequence BIGINT NOT NULL,
        tx_hash VARCHAR(64) NOT NULL,
        topic VARCHAR(128) NOT NULL,
        payload JSONB NOT NULL,
        error_message TEXT NOT NULL,
        retry_count INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_dlq_events_retry_created
        ON dlq_events (retry_count, created_at);
    `);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}