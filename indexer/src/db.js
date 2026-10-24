import { readFileSync } from "node:fs";
import pg from "pg";
import { createHash } from "node:crypto";
import { eventEmitter } from "./events.js";

/** @typedef {import('./types.js').DecodedEvent} DecodedEvent */
/** @typedef {import('./types.js').ContractMeta} ContractMeta */
/** @typedef {import('./types.js').VolumeResult} VolumeResult */

const DEFAULT_BACKEND_POOL_SIZE = 25;
const DEFAULT_INDEXER_POOL_SIZE = 10;
const DEFAULT_POOL_SIZE = 20;
const PING_TIMEOUT_MS = 5000;

/**
 * Parse and validate DATABASE_POOL_SIZE environment variable.
 * Must be an integer between 1 and 100.
 *
 * @param {string} [envVal=process.env.DATABASE_POOL_SIZE]
 * @returns {number}
 */
export function getPoolSize(
  envVal = process.env.DATABASE_POOL_SIZE,
  serviceType = process.env.SERVICE_TYPE
) {
  if (envVal === undefined || envVal === null || String(envVal).trim() === "") {
    if (serviceType === "backend") return DEFAULT_BACKEND_POOL_SIZE;
    if (serviceType === "indexer") return DEFAULT_INDEXER_POOL_SIZE;
    return DEFAULT_POOL_SIZE;
  }



  const str = String(envVal).trim();
  const parsed = Number(str);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    console.warn(
      `Invalid DATABASE_POOL_SIZE "${envVal}". Expected integer between 1 and 100. Falling back to default (${DEFAULT_POOL_SIZE}).`
    );
    return DEFAULT_POOL_SIZE;
  }
  return parsed;
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: getPoolSize(),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Error event handler: prevent unexpected idle connection drops from crashing the service
pool.on("error", (err) => {
  console.error("Unexpected error on idle database client:", err);
});
const MIGRATION_LOCK_ID = 57_056;

/** Dedicated client holding the single-writer advisory lock, if owned. */
let writerLockClient = null;
const MAX_PAGE = 200;
const CHECKPOINT_SERVICE_NAME = "soroban-indexer";
const EVENT_INSERT_SQL = `INSERT INTO events (contract_id, function, ledger, tx_hash, description, raw_topics, raw_data, sac_asset, event_addresses, onchain_seq)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  ON CONFLICT DO NOTHING`;

function eventInsertParams(ev) {
  return [
    ev.contract_id,
    ev.function,
    ev.ledger,
    ev.tx_hash,
    ev.description,
    JSON.stringify(ev.raw_topics),
    ev.raw_data,
    ev.sac_asset ?? null,
    ev.event_addresses ?? [],
    ev.onchain_seq ?? null,
  ];
}

async function insertEvent(queryable, ev) {
  await queryable.query(EVENT_INSERT_SQL, eventInsertParams(ev));
}

function escapeLikePattern(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/[\[%_]/g, "\\$&");
}

/**
 * Encodes an opaque pagination cursor from a record identifier and timestamp.
 *
 * @param {object} item
 * @param {string} [idField="id"]
 * @param {string} [timeField="created_at"]
 * @returns {string|null} base64url encoded cursor
 */
export function encodeCursor(item, idField = "id", timeField = "created_at") {
  if (!item || typeof item !== "object") return null;
  const id = item[idField] ?? item.seq ?? item.contract_id;
  const time = item[timeField]
    ? new Date(item[timeField]).toISOString()
    : item.event_count !== undefined
    ? String(item.event_count)
    : new Date().toISOString();
  return Buffer.from(JSON.stringify({ id, time })).toString("base64url");
}

/**
 * Decodes an opaque base64url cursor back into { id, time }.
 *
 * @param {string} cursorStr
 * @returns {{ id: any, time: string } | null}
 */
export function decodeCursor(cursorStr) {
  if (!cursorStr || typeof cursorStr !== "string") return null;
  try {
    const raw = Buffer.from(cursorStr, "base64url").toString("utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && (parsed.id !== undefined || parsed.time !== undefined)) {
      return parsed;
    }
  } catch {
    // Malformed cursor
  }
  return null;
}

const migrations = [
  {
    id: 1,
    name: "create_events_and_contracts",
    sql: `
      CREATE TABLE IF NOT EXISTS events (
        seq         BIGSERIAL PRIMARY KEY,
        contract_id TEXT NOT NULL,
        function    TEXT NOT NULL,
        ledger      BIGINT NOT NULL,
        tx_hash     TEXT,
        description TEXT NOT NULL,
        raw_topics  JSONB,
        raw_data    TEXT,
        sac_asset   TEXT,
        onchain_seq BIGINT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE events ADD COLUMN IF NOT EXISTS event_addresses TEXT[];
      CREATE INDEX IF NOT EXISTS idx_events_contract ON events(contract_id);
      CREATE INDEX IF NOT EXISTS idx_events_function ON events(function);
      CREATE INDEX IF NOT EXISTS idx_events_ledger   ON events(ledger);
      CREATE INDEX IF NOT EXISTS idx_events_addresses ON events USING GIN(event_addresses);

      CREATE TABLE IF NOT EXISTS indexer_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS contracts (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT,
        functions   JSONB,
        registered_by TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `,
  },
  {
    id: 2,
    name: "add_events_optional_columns",
    sql: `
      ALTER TABLE events ADD COLUMN IF NOT EXISTS sac_asset TEXT;
      ALTER TABLE events ADD COLUMN IF NOT EXISTS onchain_seq BIGINT;
    `,
  },
  {
    id: 3,
    name: "create_events_indexes",
    sql: `
      CREATE INDEX IF NOT EXISTS idx_events_contract ON events(contract_id);
      CREATE INDEX IF NOT EXISTS idx_events_function ON events(function);
      CREATE INDEX IF NOT EXISTS idx_events_ledger   ON events(ledger);
    `,
  },
  {
    id: 4,
    name: "backfill_null_event_addresses",
    sql: `
      UPDATE events SET event_addresses = ARRAY[]::TEXT[] WHERE event_addresses IS NULL;
    `,
  },
  {
    id: 5,
    name: "add_description_tsvector_gin_index",
    sql: `
      ALTER TABLE events
        ADD COLUMN IF NOT EXISTS description_tsv TSVECTOR
          GENERATED ALWAYS AS (to_tsvector('english', description)) STORED;
      CREATE INDEX IF NOT EXISTS idx_events_description_tsv
        ON events USING GIN(description_tsv);
    `,
  },
  {
    id: 6,
    name: "ensure_events_sac_asset_column",
    sql: `
      ALTER TABLE events ADD COLUMN IF NOT EXISTS sac_asset TEXT;
    `,
  },
  {
    id: 7,
    name: "create_oracle_and_markets_tables",
    sql: `
      CREATE TABLE IF NOT EXISTS markets (
        id              TEXT PRIMARY KEY,
        contract_id     TEXT NOT NULL,
        oracle_state    TEXT NOT NULL DEFAULT 'pending',
        outcome         TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_markets_contract ON markets(contract_id);
      CREATE INDEX IF NOT EXISTS idx_markets_oracle_state ON markets(oracle_state);

      CREATE TABLE IF NOT EXISTS oracle_submissions (
        id              BIGSERIAL PRIMARY KEY,
        market_id       TEXT NOT NULL,
        submitter       TEXT NOT NULL,
        outcome         TEXT NOT NULL,
        ledger          BIGINT NOT NULL,
        tx_hash         TEXT,
        timestamp       TIMESTAMPTZ DEFAULT NOW(),
        status          TEXT NOT NULL DEFAULT 'pending',
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_oracle_submissions_market ON oracle_submissions(market_id);
      CREATE INDEX IF NOT EXISTS idx_oracle_submissions_status ON oracle_submissions(status);
      CREATE INDEX IF NOT EXISTS idx_oracle_submissions_ledger ON oracle_submissions(ledger);

      CREATE TABLE IF NOT EXISTS oracle_disputes (
        id              BIGSERIAL PRIMARY KEY,
        submission_id   BIGINT NOT NULL REFERENCES oracle_submissions(id),
        market_id       TEXT NOT NULL,
        disputer        TEXT NOT NULL,
        reason          TEXT,
        ledger          BIGINT NOT NULL,
        tx_hash         TEXT,
        timestamp       TIMESTAMPTZ DEFAULT NOW(),
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_oracle_disputes_submission ON oracle_disputes(submission_id);
      CREATE INDEX IF NOT EXISTS idx_oracle_disputes_market ON oracle_disputes(market_id);
    `,
  },
];

process.on("unhandledRejection", async (err) => {
  console.error("Unhandled Rejection detected, closing database pool:", err);
  try {
    await pool.end();
  } catch (e) {
    console.error("Error closing database pool:", e);
  }
  process.exit(1);
});

export const db = {
  /**
   * Return current database connection pool health metrics.
   * @returns {{ totalCount: number, idleCount: number, waitingCount: number, max: number, isHealthy: boolean }}
   */
  getPoolMetrics() {
    const max = getPoolSize();
    const totalCount = pool.totalCount ?? 0;
    const idleCount = pool.idleCount ?? 0;
    const waitingCount = pool.waitingCount ?? 0;
    return {
      totalCount,
      idleCount,
      waitingCount,
      max,
      isHealthy: !(waitingCount > 0 && totalCount >= max),
    };
  },
  /** Run advisory-locked schema migrations before startup.
   *
   * IMPORTANT: This method acquires a dedicated client from the pool.
   * Do NOT call any other db.* method from inside a migration, because those
   * methods use pool.query directly. Drawing from the pool while a client is
   * already checked out risks deadlock under concurrent load.
   *
   * @returns {Promise<void>}
   */
  async init() {
    const client = await pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id         INTEGER PRIMARY KEY,
          name       TEXT NOT NULL,
          applied_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);

      for (const migration of migrations) {
        const { rowCount } = await client.query("SELECT 1 FROM schema_migrations WHERE id = $1", [
          migration.id,
        ]);
        if (rowCount === 0) {
          await client.query(migration.sql);
          await client.query("INSERT INTO schema_migrations (id, name) VALUES ($1, $2)", [
            migration.id,
            migration.name,
          ]);
        }
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      // The unlock is wrapped in its own try/catch so that a failure here
      // (e.g. the connection was dropped during ROLLBACK) is logged but does
      // not mask the original error or block future indexer startups waiting
      // on the advisory lock being released by the server on disconnect.
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
      } catch (unlockErr) {
        console.error("Failed to release migration advisory lock:", unlockErr);
      }
      client.release();
    }
  },

  /**
   * Run an arbitrary parameterised query against the pool.
   * @param {string} text
   * @param {any[]} [params]
   */
  async query(text, params) {
    return pool.query(text, params);
  },

  /**
   * Check if database is reachable.
   * Uses pool.query — safe to call outside of init().
   * @returns {Promise<boolean>}
   */
  async ping() {
    try {
      await pool.query({ text: "SELECT 1", query_timeout: PING_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Gracefully close the database connection pool.
   * @returns {Promise<void>}
   */
  async close() {
    await pool.end();
  },

  /**
   * Persist a decoded event to the database.
  * Skips duplicate event records (e.g. when a backfill resumes after a crash).
   * Uses pool.query — safe to call outside of init().
   *
   * @param {DecodedEvent} ev
   * @returns {Promise<void>}
   */
  async upsertEvent(ev) {
    await insertEvent(pool, ev);
    eventEmitter.emit("event", ev);
  },

  /**
   * Persist all events from a ledger and its checkpoint atomically.
   * @param {DecodedEvent[]} events
   * @param {{ sequence: number, hash: string }} checkpoint
   * @returns {Promise<void>}
   */
  async persistLedger(events, { sequence, hash }) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const ev of events) {
        await insertEvent(client, ev);
      }
      await client.query(
        `INSERT INTO checkpoint_state (service_name, last_ledger_sequence, last_ledger_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (service_name) DO UPDATE SET
           last_ledger_sequence = EXCLUDED.last_ledger_sequence,
           last_ledger_hash = EXCLUDED.last_ledger_hash,
           updated_at = NOW()`,
        [CHECKPOINT_SERVICE_NAME, sequence, hash]
      );
      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        console.error("Failed to roll back ledger transaction:", rollbackErr);
      }
      throw err;
    } finally {
      client.release();
    }

    for (const ev of events) {
      eventEmitter.emit("event", ev);
    }
  },

  /**
   * Return a paginated list of events, optionally filtered by contract and/or function.
   * Supports cursor-based pagination (opaque base64) and backward-compatible page offset.
   * Uses pool.query — safe to call outside of init().
   *
   * @param {object}  [opts]
   * @param {string}  [opts.contract]  - Filter by contract_id (exact match).
   * @param {string}  [opts.fn]        - Filter by function name (exact match).
   * @param {string}  [opts.q]         - Full-text search in description field.
   * @param {number}  [opts.page=1]    - 1-based page number.
   * @param {number}  [opts.limit=25]  - Rows per page.
   * @param {string}  [opts.cursor]    - Opaque cursor for cursor-based pagination.
   * @returns {Promise<{ events: DecodedEvent[], next_cursor: string|null, total: number, page: number, limit: number }>}
   */
  async getEvents({ contract, fn, q, page = 1, limit = 25, cursor = null } = {}) {
    const pageNum = Number(page) || 1;
    const limitNum = Math.min(MAX_PAGE, Number(limit) || 25);
    const conditions = [];
    const params = [];
    if (contract) {
      params.push(contract);
      conditions.push(`contract_id = $${params.length}`);
    }
    if (fn) {
      params.push(fn);
      conditions.push(`function = $${params.length}`);
    }
    if (q) {
      // Use the GIN-indexed tsvector column for word-only queries (letters,
      // digits, underscores, and spaces) so PostgreSQL can use the index scan.
      // Fall back to ILIKE for queries that contain special characters (e.g.
      // punctuation, operators, glob chars) which plainto_tsquery would strip
      // or misinterpret.
      const isWordSafe = /^[\w\s]+$/.test(q);
      if (isWordSafe) {
        params.push(q);
        conditions.push(`description_tsv @@ plainto_tsquery('english', $${params.length})`);
      } else {
        const escapedQ = escapeLikePattern(q);
        params.push(`%${escapedQ}%`);
        conditions.push(`description ILIKE $${params.length} ESCAPE '\\'`);
      }
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const countParams = [...params];
    const countRes = await pool.query(`SELECT COUNT(*) FROM events ${where}`, countParams);
    const total = parseInt(countRes.rows[0]?.count ?? "0", 10);

    const queryConditions = [...conditions];
    const queryParams = [...params];
    const decoded = decodeCursor(cursor);
    if (decoded) {
      queryParams.push(decoded.time, decoded.id);
      queryConditions.push(`(created_at, seq) < ($${queryParams.length - 1}, $${queryParams.length})`);
    }
    const queryWhere = queryConditions.length ? `WHERE ${queryConditions.join(" AND ")}` : "";

    const offset = (!decoded && pageNum > 1) ? (pageNum - 1) * limitNum : 0;
    queryParams.push(limitNum + 1);
    const limitIdx = queryParams.length;
    let limitClause = `LIMIT $${limitIdx}`;
    if (offset > 0) {
      queryParams.push(offset);
      limitClause += ` OFFSET $${queryParams.length}`;
    }

    const { rows } = await pool.query(
      `SELECT * FROM events ${queryWhere}
       ORDER BY ledger DESC, seq DESC ${limitClause}`,
      queryParams
    );

    let next_cursor = null;
    if (rows && rows.length > limitNum) {
      rows.pop();
      const last = rows[rows.length - 1];
      next_cursor = encodeCursor(last, "seq", "created_at");
    }

    return { events: rows || [], next_cursor, total, page: pageNum, limit: limitNum };
  },

  /**
   * Fetch a single event by its auto-increment sequence number.
   * Uses pool.query — safe to call outside of init().
   *
   * @param {number} seq
   * @returns {Promise<DecodedEvent|null>} The event row, or null if not found.
   */
  async getEvent(seq) {
    const { rows } = await pool.query("SELECT * FROM events WHERE seq = $1", [seq]);
    return rows[0] ?? null;
  },

  /**
   * Persist one immutable evidence bundle for a resolved Oracle submission.
   *
   * @param {{submission_id: string, response_payload: string, response_status: number, response_headers: Record<string, string>, resolved_at: string}} evidence
   * @returns {Promise<object>}
   */
  async createResolutionAuditLog(evidence) {
    const sortedHeaderEntries = Object.entries(evidence.response_headers).sort(
      ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
    );
    const canonicalHeaders = Object.fromEntries(sortedHeaderEntries);
    const bundle = {
      submission_id: evidence.submission_id,
      response_payload: evidence.response_payload,
      response_status: evidence.response_status,
      response_headers: sortedHeaderEntries,
      resolved_at: new Date(evidence.resolved_at).toISOString(),
    };
    const evidenceHash = createHash("sha256")
      .update(JSON.stringify(bundle))
      .digest("hex");
    const { rows } = await pool.query(
      `INSERT INTO resolution_audit_logs
         (submission_id, response_payload, response_status, response_headers, resolved_at, evidence_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (submission_id) DO NOTHING
       RETURNING id, submission_id, response_payload, response_status, response_headers,
                 resolved_at, evidence_hash, recorded_at`,
      [
        bundle.submission_id,
        bundle.response_payload,
        bundle.response_status,
        JSON.stringify(canonicalHeaders),
        bundle.resolved_at,
        evidenceHash,
      ],
    );
    if (rows[0]) {
      return rows[0];
    }

    const existing = await this.getResolutionAuditLog(bundle.submission_id);
    if (existing?.evidence_hash?.trim() === evidenceHash) {
      return existing;
    }
    const error = new Error(
      `Conflicting resolution evidence already exists for submission ${bundle.submission_id}`,
    );
    error.code = "RESOLUTION_AUDIT_CONFLICT";
    throw error;
  },

  /**
   * Fetch the immutable evidence record for an Oracle submission.
   *
   * @param {string} submissionId
   * @returns {Promise<object|null>}
   */
  async getResolutionAuditLog(submissionId) {
    const { rows } = await pool.query(
      `SELECT id, submission_id, response_payload, response_status, response_headers,
              resolved_at, evidence_hash, recorded_at
       FROM resolution_audit_logs
       WHERE submission_id = $1`,
      [submissionId],
    );
    return rows[0] ?? null;
  },

  /**
   * Return paginated events where the given address appears in the description
   * or raw_topics (case-insensitive substring match).
   * Uses pool.query — safe to call outside of init().
   *
   * @param {string} address - Stellar address (Strkey, G… or C…)
   * @param {object} [opts]
   * @param {number} [opts.page=1]  - 1-based page number.
   * @param {number} [opts.limit=25] - Rows per page.
   * @returns {Promise<{ events: DecodedEvent[], total: number, page: number, limit: number }>}
   */
  async getWalletEvents(address, { page = 1, limit = 25 } = {}) {
    const parsedPage = Number(page);
    const parsedLimit = Number(limit);
    const pageNum = Number.isFinite(parsedPage) ? Math.max(1, Math.floor(parsedPage)) : 1;
    const limitNum = Number.isFinite(parsedLimit)
      ? Math.min(MAX_PAGE, Math.max(1, Math.floor(parsedLimit)))
      : 25;
    const offset = (pageNum - 1) * limitNum;

    const countRes = await pool.query(
      "SELECT COUNT(*) FROM events WHERE event_addresses @> ARRAY[$1] AND COALESCE(event_addresses, ARRAY[]::TEXT[]) @> ARRAY[$1]",
      [address]
    );
    const total = parseInt(countRes.rows[0].count, 10);

    const { rows } = await pool.query(
      "SELECT * FROM events WHERE event_addresses @> ARRAY[$1] AND COALESCE(event_addresses, ARRAY[]::TEXT[]) @> ARRAY[$1] ORDER BY ledger DESC LIMIT $2 OFFSET $3",
      [address, limitNum, offset]
    );

    return { events: rows, total, page: pageNum, limit: limitNum };
  },

  /**
   * Fetch ABI-like metadata for a registered contract.
   * Uses pool.query — safe to call outside of init().
   *
   * @param {string} id - Strkey-encoded contract address (C…)
   * @returns {Promise<ContractMeta|null>} The contract row, or null if not registered.
   */
  async getContractMeta(id) {
    const { rows } = await pool.query("SELECT * FROM contracts WHERE id = $1", [id]);
    return rows[0] ?? null;
  },

  /**
   * Return a paginated list of registered contracts, optionally filtered by a
   * free-text query across name and description.
   *
   * @param {object}  [opts]
   * @param {string}  [opts.q]       - Case-insensitive substring search on name/description.
   * @param {number}  [opts.page=1]  - 1-based page number.
   * @param {number}  [opts.limit=25] - Rows per page.
   * @returns {Promise<{ contracts: ContractMeta[], total: number, page: number, limit: number }>}
   */
  async getContracts({ q, page = 1, limit = 25 } = {}) {
    const pageNum = Number(page) || 1;
    const limitNum = Number(limit) || 25;
    const conditions = [];
    const params = [];
    if (q) {
      const escapedQ = escapeLikePattern(q);
      params.push(`%${escapedQ}%`);
      conditions.push(
        `(name ILIKE $${params.length} ESCAPE '\\' OR description ILIKE $${params.length} ESCAPE '\\')`
      );
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const countRes = await pool.query(`SELECT COUNT(*) FROM contracts ${where}`, params);
    const total = parseInt(countRes.rows[0].count, 10);

    const offset = (pageNum - 1) * limitNum;
    // Push LIMIT and OFFSET into the params array so their $N positions are
    // always params.length (after push) regardless of how many filter params
    // precede them. This avoids the fragile +1/+2 arithmetic that breaks when
    // additional WHERE conditions are added.
    const selectParams = [...params];
    selectParams.push(limitNum);
    const limitIdx = selectParams.length; // e.g. 1 when no q, 2 when q present
    selectParams.push(offset);
    const offsetIdx = selectParams.length; // limitIdx + 1
    const { rows } = await pool.query(
      `SELECT * FROM contracts ${where}
       ORDER BY name ASC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      selectParams
    );
    return { contracts: rows, total, page: pageNum, limit: limitNum };
  },

  /**
   * Aggregate transfer volume for a contract over the last 24 hours.
   * Amounts are stored as raw strings in raw_data; we cast via NUMERIC to
   * avoid floating-point errors and return a BigInt-safe string.
   * Uses pool.query — safe to call outside of init().
   * @param {string} contractId
   * @param {number} decimals  token decimal places (default 7)
   * @returns {Promise<VolumeResult>}
   */
  async get24hVolume(contractId, decimals = 7) {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM((raw_data::jsonb->>'amount')::NUMERIC), 0)::TEXT AS volume_raw
       FROM events
       WHERE contract_id = $1
         AND function    = 'transfer'
         AND raw_data IS NOT NULL
         -- Match the first non-whitespace char so only object-shaped JSON
         -- (tolerating leading whitespace) reaches the ::jsonb cast below;
         -- arrays and other non-object JSON are excluded, not miscast.
         AND raw_data ~ '^\\s*\\{'
         AND created_at >= NOW() - INTERVAL '24 hours'`,
      [contractId]
    );
    const raw = rows[0].volume_raw ?? "0";
    // Scale using integer arithmetic via BigInt to avoid float rounding
    const rawBig = BigInt(raw.split(".")[0]); // NUMERIC may have no decimals
    const divisor = 10n ** BigInt(decimals);
    const whole = rawBig / divisor;
    const fraction = rawBig % divisor;
    const volume_scaled = `${whole}.${fraction.toString().padStart(decimals, "0")}`;
    return { volume_raw: raw, volume_scaled, decimals };
  },

  /**
   * Insert or update ABI metadata for a contract.
   * On conflict (same id) updates name, description, functions, and registered_by.
   * created_at is preserved.
   * Uses pool.query — safe to call outside of init().
   *
   * @param {ContractMeta} meta
   * @returns {Promise<void>}
   */
  async upsertContractMeta(meta) {
    await pool.query(
      `INSERT INTO contracts (id, name, description, functions, registered_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET name=$2, description=$3, functions=$4, registered_by=$5`,
      [meta.id, meta.name, meta.description, JSON.stringify(meta.functions), meta.registered_by]
    );
  },

  /**
   * Delete ABI metadata for a contract by id.
   *
   * @param {string} id - Strkey-encoded contract address (C…)
   * @returns {Promise<number>} The number of rows deleted (0 if not found).
   */
  async deleteContractMeta(id) {
    const { rowCount } = await pool.query("DELETE FROM contracts WHERE id = $1", [id]);
    return rowCount;
  },

  /**
   * Fetch distinct function names from the events table.
   * Uses pool.query — safe to call outside of init().
   * @returns {Promise<string[]>}
   */
  async getDistinctFunctions() {
    const { rows } = await pool.query("SELECT DISTINCT function FROM events ORDER BY function");
    return rows.map((r) => r.function);
  },

  /**
   * Return the top N contracts by event count, joined with the contracts
   * table to include the contract name.
   * Supports cursor-based pagination and offset pagination.
   * Uses pool.query — safe to call outside of init().
   *
   * @param {number|object} [opts=10] - Max rows or options object { limit, cursor, page }
   * @returns {Promise<Array<{ contract_id: string, name: string, event_count: number }>>}
   */
  async getLeaderboard(opts = 10) {
    let limitNum = 10;
    let cursorVal = null;
    let pageNum = 1;
    let isObjectCall = false;

    if (typeof opts === "object" && opts !== null) {
      isObjectCall = true;
      limitNum = Number(opts.limit) || 10;
      cursorVal = opts.cursor || null;
      pageNum = Number(opts.page) || 1;
    } else {
      limitNum = Number(opts) || 10;
    }

    const capped = Math.min(Math.max(limitNum, 1), 50);
    const decoded = decodeCursor(cursorVal);
    const params = [];
    let having = "";
    if (decoded) {
      params.push(Number(decoded.time) || 0, String(decoded.id));
      having = `HAVING (COUNT(*), e.contract_id) < ($1, $2)`;
    }
    const offset = (!decoded && pageNum > 1) ? (pageNum - 1) * capped : 0;
    params.push(capped + 1);
    let limitClause = `LIMIT $${params.length}`;
    if (offset > 0) {
      params.push(offset);
      limitClause += ` OFFSET $${params.length}`;
    }

    const { rows } = await pool.query(
      `SELECT e.contract_id, COALESCE(c.name, e.contract_id) AS name, COUNT(*) AS event_count
       FROM events e
       LEFT JOIN contracts c ON c.id = e.contract_id
       GROUP BY e.contract_id, COALESCE(c.name, e.contract_id)
       ${having}
       ORDER BY event_count DESC, e.contract_id DESC
       ${limitClause}`,
      params
    );

    let next_cursor = null;
    if (rows && rows.length > capped) {
      rows.pop();
      const last = rows[rows.length - 1];
      next_cursor = encodeCursor(
        { contract_id: last.contract_id, event_count: last.event_count },
        "contract_id",
        "event_count"
      );
    }

    if (isObjectCall) {
      return {
        items: rows || [],
        leaderboard: rows || [],
        next_cursor,
        limit: capped,
        page: pageNum,
      };
    }

    const arr = rows || [];
    arr.next_cursor = next_cursor;
    return arr;
  },

  /**
   * Return paginated prediction markets.
   *
   * @param {object} [opts]
   * @param {number} [opts.limit=20]
   * @param {string} [opts.cursor=null]
   * @param {number} [opts.page=1]
   * @returns {Promise<{ markets: any[], next_cursor: string|null, total: number, limit: number, page: number }>}
   */
  async getMarkets({ limit = 20, cursor = null, page = 1 } = {}) {
    const limitNum = Math.min(MAX_PAGE, Number(limit) || 20);
    const pageNum = Number(page) || 1;
    const decoded = decodeCursor(cursor);
    const params = [];
    let where = "";
    if (decoded) {
      params.push(decoded.time, decoded.id);
      where = `WHERE (created_at, id) < ($1, $2)`;
    }
    const offset = (!decoded && pageNum > 1) ? (pageNum - 1) * limitNum : 0;
    params.push(limitNum + 1);
    let limitClause = `LIMIT $${params.length}`;
    if (offset > 0) {
      params.push(offset);
      limitClause += ` OFFSET $${params.length}`;
    }

    let rows = [];
    let total = 0;
    try {
      const countRes = await pool.query("SELECT COUNT(*) FROM markets");
      total = parseInt(countRes.rows[0]?.count ?? "0", 10);
      const res = await pool.query(
        `SELECT * FROM markets ${where} ORDER BY created_at DESC, id DESC ${limitClause}`,
        params
      );
      rows = res.rows;
    } catch {
      rows = [];
    }

    let next_cursor = null;
    if (rows && rows.length > limitNum) {
      rows.pop();
      const last = rows[rows.length - 1];
      next_cursor = encodeCursor(last, "id", "created_at");
    }
    return { markets: rows, items: rows, next_cursor, total, limit: limitNum, page: pageNum };
  },

  /**
   * Return paginated bets, optionally filtered by market_id.
   *
   * @param {object} [opts]
   * @param {string} [opts.market_id=null]
   * @param {number} [opts.limit=20]
   * @param {string} [opts.cursor=null]
   * @param {number} [opts.page=1]
   * @returns {Promise<{ bets: any[], next_cursor: string|null, total: number, limit: number, page: number }>}
   */
  async getBets({ market_id = null, limit = 20, cursor = null, page = 1 } = {}) {
    const limitNum = Math.min(MAX_PAGE, Number(limit) || 20);
    const pageNum = Number(page) || 1;
    const decoded = decodeCursor(cursor);
    const conditions = [];
    const params = [];
    if (market_id) {
      params.push(market_id);
      conditions.push(`market_id = $${params.length}`);
    }
    if (decoded) {
      params.push(decoded.time, decoded.id);
      conditions.push(`(created_at, id) < ($${params.length - 1}, $${params.length})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const offset = (!decoded && pageNum > 1) ? (pageNum - 1) * limitNum : 0;
    params.push(limitNum + 1);
    let limitClause = `LIMIT $${params.length}`;
    if (offset > 0) {
      params.push(offset);
      limitClause += ` OFFSET $${params.length}`;
    }

    let rows = [];
    let total = 0;
    try {
      const countWhere = market_id ? "WHERE market_id = $1" : "";
      const countParams = market_id ? [market_id] : [];
      const countRes = await pool.query(`SELECT COUNT(*) FROM bets ${countWhere}`, countParams);
      total = parseInt(countRes.rows[0]?.count ?? "0", 10);
      const res = await pool.query(
        `SELECT * FROM bets ${where} ORDER BY created_at DESC, id DESC ${limitClause}`,
        params
      );
      rows = res.rows;
    } catch {
      rows = [];
    }

    let next_cursor = null;
    if (rows && rows.length > limitNum) {
      rows.pop();
      const last = rows[rows.length - 1];
      next_cursor = encodeCursor(last, "id", "created_at");
    }
    return { bets: rows, items: rows, next_cursor, total, limit: limitNum, page: pageNum };
  },

  /**
   * Refresh mv_leaderboard_ranks without blocking concurrent readers.
   */
  async refreshLeaderboard() {
    await pool.query("REFRESH MATERIALIZED VIEW CONCURRENTLY mv_leaderboard_ranks");
  },

  /**
   * Fetch aggregate statistics across events, contracts, and unique addresses.
   *
   * @returns {Promise<{ total_events: number, total_contracts: number, unique_addresses: number }>}
   */
  async getStats() {
    const [eventsRes, contractsRes, addressesRes] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM events"),
      pool.query("SELECT COUNT(*) FROM contracts"),
      pool.query(
        "SELECT COUNT(DISTINCT addr) FROM (SELECT unnest(event_addresses) AS addr FROM events) sub"
      ),
    ]);
    return {
      total_events: parseInt(eventsRes.rows?.[0]?.count ?? "0", 10) || 0,
      total_contracts: parseInt(contractsRes.rows?.[0]?.count ?? "0", 10) || 0,
      unique_addresses: parseInt(addressesRes.rows?.[0]?.count ?? "0", 10) || 0,
    };
  },

  /**
   * Persist an unprocessable ledger event in the dead-letter queue so it is
   * never lost across restarts or deployments.
   * Uses pool.query — safe to call outside of init().
   *
   * @param {object} entry
   * @param {number} [entry.ledger_sequence] - Ledger the event came from.
   * @param {string} [entry.tx_hash]         - Transaction hash (max 64 chars).
   * @param {string} [entry.topic]           - Event topic (max 128 chars).
   * @param {*}      [entry.payload]         - Raw event payload (stored as JSONB).
   * @param {string} [entry.error_message]   - Why the event could not be processed.
   * @returns {Promise<number>} The id of the inserted dlq_events row.
   */
  async insertDlqEvent({ ledger_sequence, tx_hash, topic, payload, error_message } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO dlq_events (ledger_sequence, tx_hash, topic, payload, error_message)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id`,
      [
        ledger_sequence ?? null,
        tx_hash ?? null,
        topic ?? null,
        payload === undefined ? null : JSON.stringify(payload),
        error_message ?? null,
      ]
    );
    return rows[0].id;
  },

  /**
   * Record a retry attempt for a dead-lettered event by incrementing
   * retry_count and refreshing created_at.
   * Uses pool.query — safe to call outside of init().
   *
   * @param {number} id - The dlq_events row id.
   * @returns {Promise<object|null>} The updated row, or null if not found.
   */
  async retryDlqEvent(id) {
    const { rows } = await pool.query(
      `UPDATE dlq_events
       SET retry_count = COALESCE(retry_count, 0) + 1,
           created_at  = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );
    return rows[0] ?? null;
  },

  /**
   * Read the persisted indexer cursor from the indexer_state table.
   * Uses pool.query — safe to call outside of init().
   * @returns {Promise<number|null>} The last successfully indexed ledger, or null.
   */
  async getCursor() {
    const { rows } = await pool.query("SELECT value FROM indexer_state WHERE key = 'last_ledger'");
    if (!rows.length) {
      return null;
    }
    const cursor = parseInt(rows[0].value, 10);
    if (Number.isNaN(cursor)) {
      console.warn(
        `Invalid cursor value found in indexer_state: ${rows[0].value} — resetting to null`
      );
      return null;
    }
    return cursor;
  },

  /**
   * Read the last atomically committed ledger checkpoint.
   * @returns {Promise<{ last_ledger_sequence: number, last_ledger_hash: string|null }|null>}
   */
  async getCheckpoint() {
    const { rows } = await pool.query(
      "SELECT last_ledger_sequence, last_ledger_hash FROM checkpoint_state WHERE service_name = $1",
      [CHECKPOINT_SERVICE_NAME]
    );
    if (!rows.length) {
      return null;
    }
    const sequence = Number(rows[0].last_ledger_sequence);
    if (!Number.isSafeInteger(sequence)) {
      throw new Error(`Invalid checkpoint ledger sequence: ${rows[0].last_ledger_sequence}`);
    }
    return { last_ledger_sequence: sequence, last_ledger_hash: rows[0].last_ledger_hash };
  },

  /**
   * Persist the indexer cursor so the process can resume from this ledger
   * after a restart.
   * Uses pool.query — safe to call outside of init().
   * @param {number} ledger
   * @returns {Promise<void>}
   */
  async setCursor(ledger) {
    await pool.query(
      `INSERT INTO indexer_state (key, value)
       VALUES ('last_ledger', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [String(ledger)]
    );
  },

  // ── Oracle & Markets ────────────────────────────────────────────────────────

  /**
   * Insert or update a market record.
   * Uses pool.query — safe to call outside of init().
   *
   * @param {object} market
   * @param {string} market.id - Market identifier
   * @param {string} market.contract_id - Contract address
   * @param {string} market.oracle_state - Oracle state (pending, submitted, disputed, finalized)
   * @param {string} [market.outcome] - Optional outcome value
   * @returns {Promise<void>}
   */
  async upsertMarket(market) {
    await pool.query(
      `INSERT INTO markets (id, contract_id, oracle_state, outcome, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (id) DO UPDATE SET 
         oracle_state = $3,
         outcome = $4,
         updated_at = NOW()`,
      [market.id, market.contract_id, market.oracle_state, market.outcome ?? null]
    );
  },

  /**
   * Get market by ID.
   * Uses pool.query — safe to call outside of init().
   *
   * @param {string} marketId
   * @returns {Promise<object|null>}
   */
  async getMarket(marketId) {
    const { rows } = await pool.query("SELECT * FROM markets WHERE id = $1", [marketId]);
    return rows[0] ?? null;
  },

  /**
   * Insert an oracle submission record.
   * Uses pool.query — safe to call outside of init().
   *
   * @param {object} submission
   * @param {string} submission.market_id - Market identifier
   * @param {string} submission.submitter - Submitter address
   * @param {string} submission.outcome - Submitted outcome
   * @param {number} submission.ledger - Ledger number
   * @param {string} [submission.tx_hash] - Transaction hash
   * @param {string} [submission.status] - Status (pending, disputed, finalized)
   * @returns {Promise<number>} The inserted submission ID
   */
  async insertOracleSubmission(submission) {
    const { rows } = await pool.query(
      `INSERT INTO oracle_submissions (market_id, submitter, outcome, ledger, tx_hash, status, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING id`,
      [
        submission.market_id,
        submission.submitter,
        submission.outcome,
        submission.ledger,
        submission.tx_hash ?? null,
        submission.status ?? "pending",
      ]
    );
    return rows[0].id;
  },

  /**
   * Update oracle submission status.
   * Uses pool.query — safe to call outside of init().
   *
   * @param {number} submissionId
   * @param {string} status
   * @returns {Promise<void>}
   */
  async updateOracleSubmissionStatus(submissionId, status) {
    await pool.query(
      `UPDATE oracle_submissions SET status = $1 WHERE id = $2`,
      [status, submissionId]
    );
  },

  /**
   * Get the most recent oracle submission for a market.
   * Uses pool.query — safe to call outside of init().
   *
   * @param {string} marketId
   * @returns {Promise<object|null>}
   */
  async getLatestOracleSubmission(marketId) {
    const { rows } = await pool.query(
      `SELECT * FROM oracle_submissions 
       WHERE market_id = $1 
       ORDER BY ledger DESC, id DESC 
       LIMIT 1`,
      [marketId]
    );
    return rows[0] ?? null;
  },

  /**
   * Insert an oracle dispute record.
   * Uses pool.query — safe to call outside of init().
   *
   * @param {object} dispute
   * @param {number} dispute.submission_id - Submission being disputed
   * @param {string} dispute.market_id - Market identifier
   * @param {string} dispute.disputer - Disputer address
   * @param {string} [dispute.reason] - Dispute reason
   * @param {number} dispute.ledger - Ledger number
   * @param {string} [dispute.tx_hash] - Transaction hash
   * @returns {Promise<number>} The inserted dispute ID
   */
  async insertOracleDispute(dispute) {
    const { rows } = await pool.query(
      `INSERT INTO oracle_disputes (submission_id, market_id, disputer, reason, ledger, tx_hash, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING id`,
      [
        dispute.submission_id,
        dispute.market_id,
        dispute.disputer,
        dispute.reason ?? null,
        dispute.ledger,
        dispute.tx_hash ?? null,
      ]
    );
    return rows[0].id;
  },

  /**
   * Execute a raw query (for testing or advanced use).
   * @param {string} text
   * @param {Array} [params]
   * @returns {Promise<object>}
   */
  async query(text, params) {
    return pool.query(text, params);
  },
};


