import { db } from "../db.js";

/**
 * Handle a 'reward_points' event by recording loyalty reward points.
 *
 * Expected event structure:
 * - topic[1]: user address (Stellar G… address)
 * - topic[2]: reason (optional, e.g., 'trade', 'stake', 'referral')
 * - data: { points: string|number, ... }
 *
 * @param {object} decodedEvent - Decoded event from decoder.js
 * @param {string} decodedEvent.contract_id - Contract address
 * @param {Array} decodedEvent.raw_topics - Array of decoded topics
 * @param {string} decodedEvent.raw_data - Stringified JSON event data
 * @param {number} decodedEvent.ledger - Ledger number
 * @param {string} [decodedEvent.tx_hash] - Transaction hash
 * @param {number} [decodedEvent.seq] - Event sequence number
 * @returns {Promise<void>}
 */
export async function handleRewardPoints(decodedEvent) {
  try {
    const { contract_id, raw_topics, raw_data, ledger, tx_hash, seq } = decodedEvent;

    // Parse topics: [function_name, user_address, reason?, ...]
    const userAddress = raw_topics[1];
    const reason = raw_topics[2];

    if (!userAddress || typeof userAddress !== "string") {
      console.warn(`[handleRewardPoints] Missing or invalid user address in event seq=${seq}`);
      return;
    }

    // Parse points from data
    let points = "0";
    try {
      const data = JSON.parse(raw_data);
      points = String(data?.points ?? data?.amount ?? data ?? "0");
    } catch (err) {
      console.warn(`[handleRewardPoints] Failed to parse raw_data for seq=${seq}:`, err.message);
      return;
    }

    // Record the reward points
    const rewardId = await db.insertReward({
      address: userAddress,
      contractId: contract_id,
      points,
      reason: typeof reason === "string" ? reason : null,
      eventSeq: seq,
      ledger,
      txHash: tx_hash,
    });

    // Get total points for logging
    const totalPoints = await db.getTotalRewardPoints(userAddress, contract_id);

    console.log(
      `[handleRewardPoints] Processed reward #${rewardId} for ${userAddress}: +${points} points${
        reason ? ` (${reason})` : ""
      } on ${contract_id} (total: ${totalPoints})`
    );
  } catch (err) {
    console.error(`[handleRewardPoints] Error processing reward_points event:`, err);
    throw err;
  }
}
