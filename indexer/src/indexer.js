// Indexer ABI cache
//
// Registered ABIs are cached for the full TTL. Negative (not-registered)
// lookups use a much shorter TTL so that a contract registered during the
// negative-cache window is re-discovered quickly instead of being served
// generic descriptions until the long TTL expires.

const ABI_TTL_MS = 60 * 1000;
const NOT_REGISTERED_TTL_MS = 2000;

// Map<contractId, { abi: object | null, expiresAt: number }>
const abiCache = new Map();

/**
 * Resolve the ABI for a contract, using a short-lived negative cache for
 * contracts that are not (yet) registered.
 *
 * @param {string} contractId
 * @param {(contractId: string) => Promise<object | null>} fetchAbi
 * @returns {Promise<object | null>}
 */
async function getAbi(contractId, fetchAbi) {
  const now = Date.now();
  const cached = abiCache.get(contractId);

  if (cached && cached.expiresAt > now) {
    return cached.abi;
  }

  const abi = await fetchAbi(contractId);

  // Negative lookups (null ABI) expire quickly so newly registered
  // contracts are picked up within NOT_REGISTERED_TTL_MS.
  const ttl = abi ? ABI_TTL_MS : NOT_REGISTERED_TTL_MS;
  abiCache.set(contractId, { abi, expiresAt: now + ttl });

  return abi;
}

/**
 * Persist an unparseable ledger event into the dead-letter queue so it is
 * never lost across container restarts or deployments.
 *
 * @param {object} db - database helper exposing insertDlqEvent(...)
 * @param {object} event - the raw ledger event that failed to parse
 * @param {Error|string} error - the error encountered while processing
 * @returns {Promise<object>} the persisted dlq_events row
 */
async function persistDlqEvent(db, event, error) {
  const errorMessage =
    error instanceof Error ? error.message : String(error);

  const payload = {
    event,
  };

  return db.insertDlqEvent({
    ledgerSequence: event.ledgerSequence ?? event.ledger_sequence ?? null,
    txHash: event.txHash ?? event.tx_hash ?? null,
    topic: event.topic ?? null,
    payload,
    errorMessage,
  });
}

/**
 * Handle an unparseable ledger event: persist it to the DLQ instead of only
 * logging to stdout. Falls back to logging if persistence itself fails so the
 * indexer keeps running.
 *
 * @param {object} db - database helper exposing insertDlqEvent(...)
 * @param {object} event - the raw ledger event that failed to parse
 * @param {Error|string} error - the error encountered while processing
 * @returns {Promise<object | null>} the persisted row, or null on failure
 */
async function handleUnparseableEvent(db, event, error) {
  const errorMessage =
    error instanceof Error ? error.message : String(error);

  try {
    return await persistDlqEvent(db, event, error);
  } catch (persistError) {
    // Last-resort logging so the failure is at least visible.
    console.error('Failed to persist unparseable ledger event to DLQ', {
      event,
      error: errorMessage,
      persistError:
        persistError instanceof Error
          ? persistError.message
          : String(persistError),
    });
    return null;
  }
}

/**
 * Retry a previously queued DLQ event. Increments retry_count and refreshes
 * created_at via the database helper.
 *
 * @param {object} db - database helper exposing retryDlqEvent(id)
 * @param {number} id - the dlq_events row id
 * @returns {Promise<object>} the updated dlq_events row
 */
async function retryDlqEvent(db, id) {
  return db.retryDlqEvent(id);
}

module.exports = {
  ABI_TTL_MS,
  NOT_REGISTERED_TTL_MS,
  getAbi,
  persistDlqEvent,
  handleUnparseableEvent,
  retryDlqEvent,
};