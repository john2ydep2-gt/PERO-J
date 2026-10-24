import { db } from "../db.js";

/**
 * Handle a 'fee_withdrawn' event by recording the fee withdrawal and
 * updating user balance.
 *
 * Expected event structure:
 * - topic[1]: user address (Stellar G… address)
 * - topic[2]: fee_type (e.g., 'protocol', 'withdraw', 'trade')
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
export async function handleFeeWithdrawn(decodedEvent) {
  try {
    const { contract_id, raw_topics, raw_data, ledger, tx_hash, seq } = decodedEvent;

    // Parse topics: [function_name, user_address, fee_type?, ...]
    const userAddress = raw_topics[1];
    const feeType = raw_topics[2] ?? "unknown";

    if (!userAddress || typeof userAddress !== "string") {
      console.warn(`[handleFeeWithdrawn] Missing or invalid user address in event seq=${seq}`);
      return;
    }

    // Parse amount from data
    let amount = "0";
    try {
      const data = JSON.parse(raw_data);
      amount = String(data?.amount ?? data ?? "0");
    } catch (err) {
      console.warn(`[handleFeeWithdrawn] Failed to parse raw_data for seq=${seq}:`, err.message);
      return;
    }

    // Record the fee withdrawal
    const feeId = await db.insertFee({
      address: userAddress,
      contractId: contract_id,
      feeType: String(feeType),
      amount,
      eventSeq: seq,
      ledger,
      txHash: tx_hash,
    });

    // Update user balance - subtract the fee from their balance
    const currentBalance = await db.getUserBalance(userAddress, contract_id);
    const newBalance = BigInt(currentBalance ?? "0") - BigInt(amount.split(".")[0]);
    // Ensure balance doesn't go negative
    await db.upsertUserBalance(
      userAddress,
      contract_id,
      newBalance < 0n ? "0" : newBalance.toString()
    );

    console.log(
      `[handleFeeWithdrawn] Processed fee #${feeId} for ${userAddress}: ${amount} (${feeType}) on ${contract_id}`
    );
  } catch (err) {
    console.error(`[handleFeeWithdrawn] Error processing fee_withdrawn event:`, err);
    throw err;
  }
}
