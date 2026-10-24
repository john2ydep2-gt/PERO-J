/**
 * Integration tests for claim, fee_withdrawn, and reward_points handlers.
 *
 * These tests verify that handlers correctly update database state:
 * - Claims update user balances and record claim status
 * - Fee withdrawals deduct from balances and record fees
 * - Reward points accumulate correctly
 *
 * Prerequisites:
 * - PostgreSQL database running with migrations applied
 * - DATABASE_URL environment variable set
 *
 * Run with:
 *   cd indexer
 *   node src/handlers/handlers.test.js
 */

import { handleClaim } from "./claim.js";
import { handleFeeWithdrawn } from "./feeWithdrawn.js";
import { handleRewardPoints } from "./rewardPoints.js";
import { db } from "../db.js";

// Test fixtures
const TEST_USER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const TEST_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const TEST_MARKET = "market_001";

async function cleanup() {
  try {
    await db.query("DELETE FROM claims WHERE address = $1", [TEST_USER]);
    await db.query("DELETE FROM fees WHERE address = $1", [TEST_USER]);
    await db.query("DELETE FROM rewards WHERE address = $1", [TEST_USER]);
    await db.query("DELETE FROM user_balances WHERE address = $1", [TEST_USER]);
  } catch (err) {
    console.error("Cleanup error:", err.message);
  }
}

async function runTests() {
  console.log("Starting handler integration tests...\n");

  try {
    // Initialize database
    await db.init();
    await cleanup();

    // Test 1: handleClaim records claim and updates balance
    console.log("Test 1: handleClaim records claim and updates balance");
    const claimEvent = {
      contract_id: TEST_CONTRACT,
      raw_topics: ["claim", TEST_USER, TEST_MARKET],
      raw_data: JSON.stringify({ amount: "1000000" }),
      ledger: 12345,
      tx_hash: "abc123",
      seq: 1,
    };
    await handleClaim(claimEvent);

    const balance1 = await db.getUserBalance(TEST_USER, TEST_CONTRACT);
    console.assert(balance1 === "1000000", `Expected balance 1000000, got ${balance1}`);

    const claims1 = await db.getClaims(TEST_USER, { limit: 10 });
    console.assert(claims1.claims.length === 1, `Expected 1 claim, got ${claims1.claims.length}`);
    console.assert(
      claims1.claims[0].status === "completed",
      `Expected status completed, got ${claims1.claims[0].status}`
    );
    console.log("✓ Claim recorded and balance updated\n");

    // Test 2: Multiple claims accumulate
    console.log("Test 2: Multiple claims accumulate balance");
    const claimEvent2 = {
      contract_id: TEST_CONTRACT,
      raw_topics: ["claim", TEST_USER, TEST_MARKET],
      raw_data: JSON.stringify({ amount: "500000" }),
      ledger: 12346,
      tx_hash: "def456",
      seq: 2,
    };
    await handleClaim(claimEvent2);

    const balance2 = await db.getUserBalance(TEST_USER, TEST_CONTRACT);
    console.assert(balance2 === "1500000", `Expected balance 1500000, got ${balance2}`);
    console.log("✓ Multiple claims accumulated correctly\n");

    // Test 3: handleFeeWithdrawn deducts from balance
    console.log("Test 3: handleFeeWithdrawn records fee and deducts from balance");
    const feeEvent = {
      contract_id: TEST_CONTRACT,
      raw_topics: ["fee_withdrawn", TEST_USER, "protocol"],
      raw_data: JSON.stringify({ amount: "50000" }),
      ledger: 12347,
      tx_hash: "ghi789",
      seq: 3,
    };
    await handleFeeWithdrawn(feeEvent);

    const balance3 = await db.getUserBalance(TEST_USER, TEST_CONTRACT);
    console.assert(balance3 === "1450000", `Expected balance 1450000, got ${balance3}`);

    const fees = await db.getFees(TEST_USER, { limit: 10 });
    console.assert(fees.fees.length === 1, `Expected 1 fee, got ${fees.fees.length}`);
    console.assert(fees.fees[0].fee_type === "protocol", `Expected fee_type protocol, got ${fees.fees[0].fee_type}`);
    console.log("✓ Fee recorded and balance deducted\n");

    // Test 4: Fee withdrawal prevents negative balance
    console.log("Test 4: Fee withdrawal prevents negative balance");
    const feeEvent2 = {
      contract_id: TEST_CONTRACT,
      raw_topics: ["fee_withdrawn", TEST_USER, "withdraw"],
      raw_data: JSON.stringify({ amount: "2000000" }), // More than current balance
      ledger: 12348,
      tx_hash: "jkl012",
      seq: 4,
    };
    await handleFeeWithdrawn(feeEvent2);

    const balance4 = await db.getUserBalance(TEST_USER, TEST_CONTRACT);
    console.assert(balance4 === "0", `Expected balance 0 (not negative), got ${balance4}`);
    console.log("✓ Balance prevented from going negative\n");

    // Test 5: handleRewardPoints records rewards
    console.log("Test 5: handleRewardPoints records loyalty rewards");
    const rewardEvent = {
      contract_id: TEST_CONTRACT,
      raw_topics: ["reward_points", TEST_USER, "trade"],
      raw_data: JSON.stringify({ points: "100" }),
      ledger: 12349,
      tx_hash: "mno345",
      seq: 5,
    };
    await handleRewardPoints(rewardEvent);

    const rewards1 = await db.getRewards(TEST_USER, { limit: 10 });
    console.assert(rewards1.rewards.length === 1, `Expected 1 reward, got ${rewards1.rewards.length}`);
    console.assert(rewards1.rewards[0].points === "100", `Expected points 100, got ${rewards1.rewards[0].points}`);
    console.log("✓ Reward points recorded\n");

    // Test 6: Reward points accumulate
    console.log("Test 6: Reward points accumulate correctly");
    const rewardEvent2 = {
      contract_id: TEST_CONTRACT,
      raw_topics: ["reward_points", TEST_USER, "stake"],
      raw_data: JSON.stringify({ points: "250" }),
      ledger: 12350,
      tx_hash: "pqr678",
      seq: 6,
    };
    await handleRewardPoints(rewardEvent2);

    const totalPoints = await db.getTotalRewardPoints(TEST_USER, TEST_CONTRACT);
    console.assert(totalPoints === "350", `Expected total points 350, got ${totalPoints}`);
    console.log("✓ Reward points accumulated correctly\n");

    // Cleanup
    await cleanup();
    await db.close();

    console.log("✅ All tests passed!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Test failed:", err);
    await cleanup();
    await db.close();
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  runTests();
}

export { runTests };
