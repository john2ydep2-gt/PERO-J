import client from 'prom-client';

export const register = new client.Registry();

export const currentLedger = new client.Gauge({
  name: 'indexer_current_ledger',
  help: 'Most recent ledger sequence processed by the indexer',
  registers: [register],
});

export const chainHeadLedger = new client.Gauge({
  name: 'indexer_chain_head_ledger',
  help: 'Latest ledger sequence reported by the RPC node',
  registers: [register],
});

export const lagLedgers = new client.Gauge({
  name: 'indexer_lag_ledgers',
  help: "Ledgers between the chain head and the indexer's current ledger",
  registers: [register],
});

export const eventsProcessed = new client.Counter({
  name: 'indexer_events_processed_total',
  help: 'Total contract events processed by the indexer',
  registers: [register],
});

export const errors = new client.Counter({
  name: 'indexer_errors_total',
  help: 'Total errors encountered in the indexer poll loop',
  registers: [register],
});

/**
 * Record indexing progress; lag is derived so it can never drift from the
 * two gauges it is computed from.
 *
 * @param {number} current - Ledger just processed.
 * @param {number} head - Chain head reported by RPC.
 */
export function recordProgress(current, head) {
  currentLedger.set(current);
  chainHeadLedger.set(head);
  lagLedgers.set(Math.max(0, head - current));
}
