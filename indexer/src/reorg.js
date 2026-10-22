import { db } from './db.js';

/** Number of recent ledger hashes retained for continuity checks. */
export const REORG_WINDOW = 32;

/**
 * Fetch canonical ledger hashes from the RPC node via the `getLedgers`
 * JSON-RPC method (not exposed by the SDK version in use).
 *
 * @param {string} rpcUrl
 * @param {number} startLedger
 * @param {number} limit
 * @returns {Promise<Map<number, string>>} sequence -> hash
 */
export async function fetchLedgerHashes(rpcUrl, startLedger, limit) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getLedgers',
      params: { startLedger, pagination: { limit } },
    }),
  });
  const body = await res.json();
  if (body.error) {
    throw new Error(`getLedgers failed: ${body.error.message}`);
  }
  return new Map(
    (body.result?.ledgers ?? []).map((l) => [Number(l.sequence), l.hash]),
  );
}

/**
 * Compare the stored sliding window of ledger hashes against the RPC node.
 * Returns the lowest stored ledger whose hash no longer matches (the fork
 * point), or null when the window is consistent. Ledgers the RPC node no
 * longer retains are skipped rather than treated as divergence.
 *
 * @param {(start: number, limit: number) => Promise<Map<number, string>>} getHashes
 * @returns {Promise<number|null>}
 */
export async function detectReorg(getHashes) {
  const stored = await db.getIndexedLedgers(REORG_WINDOW);
  if (!stored.length) {
    return null;
  }
  const first = stored[0].ledger;
  const last = stored[stored.length - 1].ledger;
  const canonical = await getHashes(first, last - first + 1);
  for (const { ledger, hash } of stored) {
    const current = canonical.get(ledger);
    if (current !== undefined && current !== hash) {
      return ledger;
    }
  }
  return null;
}
