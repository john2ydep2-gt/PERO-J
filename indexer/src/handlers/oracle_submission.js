import { db } from "../db.js";
import { invalidateMarketCache } from "../cache.js";

/**
 * Handle oracle_submission events.
 * 
 * When an oracle submits an outcome for a market, we:
 * 1. Insert a new oracle_submission record
 * 2. Update the market's oracle_state to 'submitted'
 * 3. Invalidate the cache for this market
 * 
 * @param {object} decoded - Decoded event from decoder.js
 * @param {string} decoded.contract_id - Contract address
 * @param {string} decoded.function - Event name (oracle_submission)
 * @param {number} decoded.ledger - Ledger number
 * @param {string} decoded.tx_hash - Transaction hash
 * @param {unknown[]} topics - Decoded event topics [fn_name, market_id, submitter, outcome, ...]
 * @param {unknown} data - Decoded event data
 * @returns {Promise<void>}
 */
export async function handleOracleSubmission(decoded, topics, data) {
  try {
    // Topics structure: [fn_name, market_id, submitter, outcome]
    // topics[0] is the function name symbol, already extracted as decoded.function
    const marketId = String(topics[1] ?? "");
    const submitter = String(topics[2] ?? "");
    const outcome = String(topics[3] ?? data ?? "");

    if (!marketId || !submitter) {
      console.warn(`[oracle_submission] Missing required fields: market_id=${marketId}, submitter=${submitter}`);
      return;
    }

    console.log(`[oracle_submission] Processing: market=${marketId}, submitter=${submitter}, outcome=${outcome}`);

    // Insert oracle submission record
    const submissionId = await db.insertOracleSubmission({
      market_id: marketId,
      submitter,
      outcome,
      ledger: decoded.ledger,
      tx_hash: decoded.tx_hash,
      status: "pending",
    });

    console.log(`[oracle_submission] Created submission ${submissionId} for market ${marketId}`);

    // Update market oracle state
    await db.upsertMarket({
      id: marketId,
      contract_id: decoded.contract_id,
      oracle_state: "submitted",
      outcome,
    });

    // Invalidate cache for this market
    await invalidateMarketCache(marketId).catch((err) => {
      console.warn(`[oracle_submission] Cache invalidation failed for market ${marketId}:`, err.message);
    });

    console.log(`[oracle_submission] Updated market ${marketId} state to 'submitted'`);
  } catch (err) {
    console.error("[oracle_submission] Handler error:", {
      contract: decoded.contract_id,
      ledger: decoded.ledger,
      error: err.message,
      stack: err.stack,
    });
    // Don't throw - let the indexer continue processing other events
  }
}
