import { db } from "../db.js";
import { invalidateMarketCache } from "../cache.js";

/**
 * Handle oracle_finalized events.
 * 
 * When an oracle outcome is finalized (after the dispute window expires or dispute is resolved), we:
 * 1. Find the relevant oracle submission
 * 2. Update the submission status to 'finalized'
 * 3. Update the market's oracle_state to 'finalized'
 * 4. Invalidate the cache for this market
 * 
 * @param {object} decoded - Decoded event from decoder.js
 * @param {string} decoded.contract_id - Contract address
 * @param {string} decoded.function - Event name (oracle_finalized)
 * @param {number} decoded.ledger - Ledger number
 * @param {string} decoded.tx_hash - Transaction hash
 * @param {unknown[]} topics - Decoded event topics [fn_name, market_id, final_outcome, ...]
 * @param {unknown} data - Decoded event data
 * @returns {Promise<void>}
 */
export async function handleOracleFinalized(decoded, topics, data) {
  try {
    // Topics structure: [fn_name, market_id, final_outcome]
    const marketId = String(topics[1] ?? "");
    const finalOutcome = String(topics[2] ?? data ?? "");

    if (!marketId) {
      console.warn(`[oracle_finalized] Missing market_id`);
      return;
    }

    console.log(`[oracle_finalized] Processing: market=${marketId}, outcome=${finalOutcome}`);

    // Find the most recent submission for this market
    const submission = await db.getLatestOracleSubmission(marketId);
    
    if (submission) {
      // Update submission status to finalized
      await db.updateOracleSubmissionStatus(submission.id, "finalized");
      console.log(`[oracle_finalized] Finalized submission ${submission.id}`);
    } else {
      console.warn(`[oracle_finalized] No submission found for market ${marketId}, creating market entry anyway`);
    }

    // Update market oracle state to finalized with the final outcome
    await db.upsertMarket({
      id: marketId,
      contract_id: decoded.contract_id,
      oracle_state: "finalized",
      outcome: finalOutcome,
    });

    // Invalidate cache for this market
    await invalidateMarketCache(marketId).catch((err) => {
      console.warn(`[oracle_finalized] Cache invalidation failed for market ${marketId}:`, err.message);
    });

    console.log(`[oracle_finalized] Updated market ${marketId} state to 'finalized' with outcome: ${finalOutcome}`);
  } catch (err) {
    console.error("[oracle_finalized] Handler error:", {
      contract: decoded.contract_id,
      ledger: decoded.ledger,
      error: err.message,
      stack: err.stack,
    });
    // Don't throw - let the indexer continue processing other events
  }
}
