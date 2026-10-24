import { db } from "../db.js";

/**
 * Handle a 'claim' event by recording the claim and updating user balance.
 *
 * Expected event structure:
 * - topic[1]: user address (Stellar G… address)
 * - topic[2]: market_id (optional)
 * - data: { amount: string|number, ... }
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
export async function handleClaim(decodedEvent) {
  try {
    const { contract_id, raw_topics, raw_data, ledger, tx_hash, seq } = decodedEvent;

    // Parse topics: [function_name, user_address, market_id?, ...]
    const userAddress = raw_topics[1];
    const marketId = raw_topics[2];

    if (!userAddress || typeof userAddress !== "string") {
      console.warn(`[handleClaim] Missing or invalid user address in event seq=${seq}`);
      return;
    }

    // Parse amount from data
    let amount = "0";
    try {
      const data = JSON.parse(raw_data);
      amount = String(data?.amount ?? data ?? "0");
    } catch (err) {
      console.warn(`[handleClaim] Failed to parse raw_data for seq=${seq}:`, err.message);
      return;
    }

    // Record the claim
    const claimId = await db.insertClaim({
      address: userAddress,
      contractId: contract_id,
      marketId: typeof marketId === "string" ? marketId : null,
      amount,
      status: "completed",
      eventSeq: seq,
      ledger,
      txHash: tx_hash,
    });

    // Update user balance - add the claimed amount to their balance
    const currentBalance = await db.getUserBalance(userAddress, contract_id);
    const newBalance = BigInt(currentBalance ?? "0") + BigInt(amount.split(".")[0]);
    await db.upsertUserBalance(userAddress, contract_id, newBalance.toString());

    console.log(
      `[handleClaim] Processed claim #${claimId} for ${userAddress}: ${amount} on ${contract_id}`
    );
  } catch (err) {
    console.error(`[handleClaim] Error processing claim event:`, err);
    throw err;
  }
}
