import type { Pool } from 'pg';

export interface BetPlacedEvent {
  txHash: string;
  eventIndex: number;
  marketId: string | number | bigint;
  bettor: string;
  isYes: boolean;
  grossAmount: string | number | bigint;
  netAmount: string | number | bigint;
  /** Unix timestamp in seconds. */
  timestamp: number;
}

/**
 * Persist a BetPlaced event. The bet insert and the market totals update run in
 * one transaction, and the insert is keyed on (tx_hash, event_index) so replays
 * of the same event are no-ops.
 *
 * @returns true if the event was applied, false if it was already processed.
 */
export async function handleBetPlaced(
  pool: Pool,
  e: BetPlacedEvent,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const inserted = await client.query(
      `INSERT INTO bets
         (tx_hash, event_index, market_id, bettor, is_yes, gross_amount, net_amount, placed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8))
       ON CONFLICT (tx_hash, event_index) DO NOTHING`,
      [
        e.txHash,
        e.eventIndex,
        e.marketId,
        e.bettor,
        e.isYes,
        e.grossAmount,
        e.netAmount,
        e.timestamp,
      ],
    );

    if (inserted.rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }

    await client.query(
      `INSERT INTO markets (market_id, total_yes, total_no, bet_count)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (market_id) DO UPDATE SET
         total_yes = markets.total_yes + EXCLUDED.total_yes,
         total_no  = markets.total_no  + EXCLUDED.total_no,
         bet_count = markets.bet_count + 1`,
      [e.marketId, e.isYes ? e.netAmount : 0, e.isYes ? 0 : e.netAmount],
    );

    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
