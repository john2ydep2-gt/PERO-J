import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_INTERVAL_MS = 10 * 60_000;
const SAMPLE_SIZE = 10;

/** Cumulative drift metrics, exposed for health/metrics consumers. */
export const driftMetrics = {
  audits: 0,
  marketsChecked: 0,
  driftDetected: 0,
  lastRunAt: null,
};

/**
 * Read `total_yes` / `total_no` for a market directly from contract storage
 * via the `get_market` contract function.
 *
 * @param {string} marketId
 * @returns {Promise<{ total_yes: string, total_no: string }>}
 */
export async function fetchOnchainTotals(marketId) {
  const { stdout } = await execFileAsync('soroban', [
    'contract',
    'invoke',
    '--id',
    process.env.PERO_MARKET_CONTRACT_ID,
    '--source',
    process.env.SOROBAN_EXPLORER_ADMIN_SECRET,
    '--rpc-url',
    process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
    '--network-passphrase',
    process.env.NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
    '--',
    'get_market',
    '--market_id',
    marketId,
  ]);
  return JSON.parse(stdout);
}

/**
 * Sample random active markets and compare on-chain totals with the DB cache.
 * Emits one structured alert per mismatching market.
 *
 * @param {{ query: Function }} db
 * @param {(marketId: string) => Promise<{ total_yes: any, total_no: any }>} [fetchTotals]
 * @param {number} [sampleSize]
 * @returns {Promise<{ checked: number, drifted: number }>}
 */
export async function runDriftAudit(
  db,
  fetchTotals = fetchOnchainTotals,
  sampleSize = SAMPLE_SIZE,
) {
  const { rows } = await db.query(
    "SELECT id, total_yes, total_no FROM markets WHERE status = 'open' ORDER BY random() LIMIT $1",
    [sampleSize],
  );
  let drifted = 0;

  for (const row of rows) {
    try {
      const chain = await fetchTotals(row.id);
      const yesDiff =
        BigInt(chain.total_yes) - BigInt(String(row.total_yes).split('.')[0]);
      const noDiff =
        BigInt(chain.total_no) - BigInt(String(row.total_no).split('.')[0]);
      if (yesDiff !== 0n || noDiff !== 0n) {
        drifted++;
        console.error(
          JSON.stringify({
            level: 'alert',
            event: 'state_drift_detected',
            market_id: row.id,
            db: {
              total_yes: String(row.total_yes),
              total_no: String(row.total_no),
            },
            chain: {
              total_yes: String(chain.total_yes),
              total_no: String(chain.total_no),
            },
            drift: { total_yes: String(yesDiff), total_no: String(noDiff) },
          }),
        );
      }
    } catch (err) {
      console.error(`[drift] failed to audit market ${row.id}:`, err.message);
    }
  }

  driftMetrics.audits++;
  driftMetrics.marketsChecked += rows.length;
  driftMetrics.driftDetected += drifted;
  driftMetrics.lastRunAt = Date.now();
  console.log(
    JSON.stringify({
      event: 'drift_audit_complete',
      checked: rows.length,
      drifted,
      ...driftMetrics,
    }),
  );
  return { checked: rows.length, drifted };
}

/**
 * Start the periodic drift audit. Returns a function that stops it.
 *
 * @param {{ query: Function }} db
 * @param {{ intervalMs?: number }} [opts]
 * @returns {() => void}
 */
export function startDriftDetector(db, opts = {}) {
  const timer = setInterval(() => {
    runDriftAudit(db).catch((err) =>
      console.error('[drift] audit failed:', err.message),
    );
  }, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
