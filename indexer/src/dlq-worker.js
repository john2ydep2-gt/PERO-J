const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 30_000;
const BATCH_SIZE = 50;

/**
 * Permanent errors (schema/constraint/data problems) will not succeed on retry.
 * Postgres classes 22 (data), 23 (integrity) and 42 (syntax/schema).
 *
 * @param {any} err
 * @returns {boolean}
 */
export function isPermanentError(err) {
  const code = String(err?.code ?? '');
  return (
    /^(22|23|42)/.test(code) ||
    err instanceof SyntaxError ||
    err instanceof TypeError
  );
}

/**
 * Process one batch of pending DLQ rows. Each row is re-dispatched; on failure
 * `retry_count` is bumped and `next_retry_at` pushed out exponentially. Rows
 * hitting the retry limit (or a permanent error) are left unresolved and an
 * alert is logged with the stack trace.
 *
 * @param {{ query: Function }} db
 * @param {(payload: object) => Promise<void>} dispatch
 * @param {number} [maxRetries]
 * @returns {Promise<{ resolved: number, failed: number, exhausted: number }>}
 */
export async function retryDlqBatch(
  db,
  dispatch,
  maxRetries = DEFAULT_MAX_RETRIES,
) {
  const { rows } = await db.query(
    `SELECT id, payload, retry_count FROM dlq_events
      WHERE NOT resolved AND retry_count < $1 AND next_retry_at <= NOW()
      ORDER BY id LIMIT $2`,
    [maxRetries, BATCH_SIZE],
  );
  const stats = { resolved: 0, failed: 0, exhausted: 0 };

  for (const row of rows) {
    try {
      await dispatch(row.payload);
      await db.query('UPDATE dlq_events SET resolved = TRUE WHERE id = $1', [
        row.id,
      ]);
      stats.resolved++;
    } catch (err) {
      const retries = isPermanentError(err) ? maxRetries : row.retry_count + 1;
      const delayMs = BASE_BACKOFF_MS * 2 ** row.retry_count;
      await db.query(
        `UPDATE dlq_events
            SET retry_count = $2, error = $3, stack = $4,
                next_retry_at = NOW() + ($5 * INTERVAL '1 millisecond')
          WHERE id = $1`,
        [row.id, retries, err.message, err.stack ?? null, delayMs],
      );
      stats.failed++;
      if (retries >= maxRetries) {
        stats.exhausted++;
        console.error(
          JSON.stringify({
            level: 'alert',
            event: 'dlq_max_retries_exceeded',
            dlq_id: row.id,
            error: err.message,
          }),
          err.stack,
        );
      }
    }
  }
  return stats;
}

/**
 * Start the periodic DLQ retry task. Returns a function that stops it.
 *
 * @param {{ query: Function }} db
 * @param {(payload: object) => Promise<void>} dispatch
 * @param {{ intervalMs?: number, maxRetries?: number }} [opts]
 * @returns {() => void}
 */
export function startDlqRetryWorker(db, dispatch, opts = {}) {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timer = setInterval(() => {
    retryDlqBatch(db, dispatch, opts.maxRetries).catch((err) =>
      console.error('[dlq] retry batch failed:', err.message),
    );
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
