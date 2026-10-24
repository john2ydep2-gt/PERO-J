import { db } from "../db.js";
import { invalidateMarketCache } from "../cache.js";

/**
 * Handle oracle_dispute events.
 * 
 * When an oracle submission is challenged/disputed, we:
 * 1. Find the relevant oracle submission
 * 2. Insert a dispute record
 * 3. Update the submission status to 'disputed'
 * 4. Update the market's oracle_state to 'disputed'
 * 5. Invalidate the cache for this market
 * 
 * @param {object} decoded - Decoded event from decoder.js
 * @param {string} decoded.contract_id - Contract address
 * @param {string} decoded.function - Event name (oracle_dispute)
 * @param {number} decoded.ledger - Ledger number
 * @param {string} decoded.tx_hash - Transaction hash
 * @param {unknown[]} topics - Decoded event topics [fn_name, market_id, disputer, reason, ...]
 * @param {unknown} data - Decoded event data
 * @returns {Promise<void>}
 */
export async function handleOracleDispute(decoded, topics, data) {
  try {
    // Topics structure: [fn_name, market_id, disputer, reason?]
    const marketId = String(topics[1] ?? "");
    const disputer = String(topics[2] ?? "");
    const reason = String(topics[3] ?? data ?? "");

    if (!marketId || !disputer) {
      console.warn(`[oracle_dispute] Missing required fields: market_id=${marketId}, disputer=${disputer}`);
      return;
    }

    console.log(`[oracle_dispute] Processing: market=${marketId}, disputer=${disputer}`);

    // Find the most recent submission for this market
    const submission = await db.getLatestOracleSubmission(marketId);
    
    if (!submission) {
      console.warn(`[oracle_dispute] No submission found for market ${marketId} to dispute`);
      return;
    }

    // Insert dispute record
    const disputeId = await db.insertOracleDispute({
      submission_id: submission.id,
      market_id: marketId,
      disputer,
      reason: reason || null,
      ledger: decoded.ledger,
      tx_hash: decoded.tx_hash,
    });

    console.log(`[oracle_dispute] Created dispute ${disputeId} for submission ${submission.id}`);

    // Update submission status
    await db.updateOracleSubmissionStatus(submission.id, "disputed");

    // Update market oracle state
    await db.upsertMarket({
      id: marketId,
      contract_id: decoded.contract_id,
      oracle_state: "disputed",
      outcome: submission.outcome, // Preserve the disputed outcome
    });

    // Invalidate cache for this market
    await invalidateMarketCache(marketId).catch((err) => {
      console.warn(`[oracle_dispute] Cache invalidation failed for market ${marketId}:`, err.message);
    });

    console.log(`[oracle_dispute] Updated market ${marketId} state to 'disputed'`);
  } catch (err) {
    console.error("[oracle_dispute] Handler error:", {
      contract: decoded.contract_id,
      ledger: decoded.ledger,
      error: err.message,
      stack: err.stack,
    });
    // Don't throw - let the indexer continue processing other events
  }
}
