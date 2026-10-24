import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/api.js";
import { db } from "../src/db.js";
import {
  MarketCacheManager,
  marketCacheManager,
  calculateOdds,
  BET_PLACED_CHANNEL,
} from "../src/cache-manager.js";
import {
  BondEscrowWorker,
  bondEscrowWorker,
  EscrowInvariantError,
} from "../src/bond-escrow-worker.js";
import { getRedisClient, resetRedis, publish } from "../src/redis.js";

describe("Redis Cache Invalidation triggered by BetPlaced events (issue #968)", () => {
  beforeEach(() => {
    resetRedis();
  });

  it("calculates accurate outcome odds from pools", () => {
    const pools = { yes: 6000, no: 4000 };
    const odds = calculateOdds(pools, 10000);
    assert.equal(odds.yes, 1.6667);
    assert.equal(odds.no, 2.5);
  });

  it("purges market and odds cache keys and pre-warms fresh totals in < 100ms", async () => {
    const manager = new MarketCacheManager();
    const redis = getRedisClient();

    // 1. Seed stale cache
    const marketId = "mkt-soroban-1";
    await redis.set(`market:${marketId}`, JSON.stringify({ id: marketId, total_volume: 500 }));
    await redis.set(`market:${marketId}:odds`, JSON.stringify({ yes: 2.0, no: 2.0 }));

    assert.equal(await redis.exists(`market:${marketId}`), 1);
    assert.equal(await redis.exists(`market:${marketId}:odds`), 1);

    // 2. BetPlaced event arrives
    const eventPayload = {
      market_id: marketId,
      total_pool: 15000,
      outcome_pools: { yes: 10000, no: 5000 },
      odds: { yes: 1.5, no: 3.0 },
      market: { id: marketId, total_volume: 15000 },
    };

    const res = await manager.handleBetPlacedEvent(eventPayload);

    // Verify SLA: cache invalidation & pre-warming occurred under 100ms
    assert.equal(res.success, true);
    assert.equal(res.market_id, marketId);
    assert.ok(res.latency_ms < 100, `Latency ${res.latency_ms}ms should be < 100ms`);

    // Verify cache pre-warmed with updated fresh odds
    const freshOdds = await manager.getMarketOdds(marketId);
    assert.deepEqual(freshOdds, { yes: 1.5, no: 3.0 });

    const freshMarket = await manager.getMarket(marketId);
    assert.equal(freshMarket.total_volume, 15000);
  });

  it("processes BetPlaced pub/sub events published to stellar:events:mkt:bet", async () => {
    const manager = new MarketCacheManager();
    manager.start();

    const marketId = "mkt-soroban-pubsub";
    const eventPayload = {
      market_id: marketId,
      total_pool: 20000,
      outcome_pools: { yes: 10000, no: 10000 },
      odds: { yes: 2.0, no: 2.0 },
      market: { id: marketId, total_volume: 20000 },
    };

    await publish(BET_PLACED_CHANNEL, eventPayload);

    // Allow event emission cycle
    await new Promise((r) => setTimeout(r, 20));

    const odds = await manager.getMarketOdds(marketId);
    assert.deepEqual(odds, { yes: 2.0, no: 2.0 });

    manager.stop();
  });

  it("serves fresh odds and invalidates cache via HTTP endpoints", async () => {
    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const marketId = "mkt-live-http";

      // 1. Post BetPlaced event
      const betEvent = {
        market_id: marketId,
        total_pool: 12000,
        outcome_pools: { yes: 8000, no: 4000 },
        odds: { yes: 1.5, no: 3.0 },
        market: { id: marketId, question: "Will Soroban protocol launch?" },
      };

      const postRes = await fetch(`${baseUrl}/api/v1/events/bet-placed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(betEvent),
      });

      assert.equal(postRes.status, 200);
      const postData = await postRes.json();
      assert.equal(postData.success, true);
      assert.ok(postData.latency_ms < 100);

      // 2. Query market details
      const marketRes = await fetch(`${baseUrl}/api/v1/markets/${marketId}`);
      assert.equal(marketRes.status, 200);
      const marketData = await marketRes.json();
      assert.equal(marketData.id, marketId);

      // 3. Query market odds immediately
      const oddsRes = await fetch(`${baseUrl}/api/v1/markets/${marketId}/odds`);
      assert.equal(oddsRes.status, 200);
      const oddsData = await oddsRes.json();
      assert.deepEqual(oddsData.odds, { yes: 1.5, no: 3.0 });
    } finally {
      marketCacheManager.stop();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("Bond Escrow Invariant Verification Worker (issue #958)", () => {
  it("asserts escrow_in == escrow_out invariant when accounting balances match", () => {
    const worker = new BondEscrowWorker();
    const totalDeposited = 50000;
    const totalSettled = 20000;
    const contractHoldings = 30000;

    assert.doesNotThrow(() => {
      worker.assertInvariant(totalDeposited, totalSettled, contractHoldings);
    });
  });

  it("throws EscrowInvariantError and detects fund leakage on collateral discrepancy", () => {
    const worker = new BondEscrowWorker();
    const totalDeposited = 50000;
    const totalSettled = 20000;
    const leakedContractHoldings = 25000; // 5000 missing!

    assert.throws(
      () => {
        worker.assertInvariant(totalDeposited, totalSettled, leakedContractHoldings);
      },
      (err) => {
        assert.ok(err instanceof EscrowInvariantError);
        assert.equal(err.details.leakage_amount, "5000");
        return true;
      }
    );
  });

  it("trips circuit breaker, halts automated resolution, and alerts on invariant violation", async () => {
    let alertFired = false;
    let alertData = null;

    const mockDb = {
      getBondAccounting: async () => ({
        total_bonds_deposited: 100_000,
        total_bonds_settled: 40_000,
        expected_escrow_holdings: 60_000,
        active_disputes: 3,
      }),
    };

    const worker = new BondEscrowWorker({
      database: mockDb,
      onAlert: (alert) => {
        alertFired = true;
        alertData = alert;
      },
    });

    assert.equal(worker.isResolutionAllowed(), true);

    // 1. Run audit with matching contract balance -> valid
    const validReport = await worker.verifyEscrowInvariant({ contractBalance: 60_000 });
    assert.equal(validReport.valid, true);
    assert.equal(worker.isResolutionAllowed(), true);
    assert.equal(worker.getCircuitBreakerStatus().tripped, false);

    // 2. Run audit with mismatched contract balance (leakage) -> trips circuit breaker
    const mismatchReport = await worker.verifyEscrowInvariant({ contractBalance: 58_000 });
    assert.equal(mismatchReport.valid, false);
    assert.equal(worker.isResolutionAllowed(), false);
    assert.equal(worker.getCircuitBreakerStatus().tripped, true);
    assert.equal(worker.getCircuitBreakerStatus().automated_resolution_halted, true);

    assert.equal(alertFired, true);
    assert.equal(alertData.level, "CRITICAL");
    assert.equal(alertData.type, "BOND_ESCROW_INVARIANT_VIOLATION");
    assert.equal(alertData.details.leakage_amount, "2000");

    // 3. Reset circuit breaker allows manual operational resumption
    worker.resetCircuitBreaker();
    assert.equal(worker.isResolutionAllowed(), true);
    assert.equal(worker.getCircuitBreakerStatus().tripped, false);
  });

  it("exposes circuit-breaker and audit-bonds REST endpoints", async () => {
    const originalGetAccounting = db.getBondAccounting;
    db.getBondAccounting = async () => ({
      total_bonds_deposited: 80_000,
      total_bonds_settled: 30_000,
      expected_escrow_holdings: 50_000,
      active_disputes: 2,
    });

    const app = createApp();
    const server = app.listen(0);
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. Initial circuit breaker status is healthy
      const statusRes = await fetch(`${baseUrl}/api/v1/oracle/circuit-breaker`);
      assert.equal(statusRes.status, 200);
      const statusData = await statusRes.json();
      assert.equal(statusData.tripped, false);
      assert.equal(statusData.automated_resolution_halted, false);

      // 2. Perform successful audit
      const auditRes = await fetch(`${baseUrl}/api/v1/oracle/audit-bonds`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contract_balance: 50_000 }),
      });
      assert.equal(auditRes.status, 200);
      const auditData = await auditRes.json();
      assert.equal(auditData.valid, true);

      // 3. Perform audit with mismatch (leakage detected)
      const auditLeakRes = await fetch(`${baseUrl}/api/v1/oracle/audit-bonds`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contract_balance: 45_000 }), // 5000 leak!
      });
      assert.equal(auditLeakRes.status, 409);
      const auditLeakData = await auditLeakRes.json();
      assert.equal(auditLeakData.valid, false);

      // 4. Verify circuit breaker is tripped and halts resolution
      const trippedStatusRes = await fetch(`${baseUrl}/api/v1/oracle/circuit-breaker`);
      const trippedStatusData = await trippedStatusRes.json();
      assert.equal(trippedStatusData.tripped, true);
      assert.equal(trippedStatusData.automated_resolution_halted, true);
    } finally {
      db.getBondAccounting = originalGetAccounting;
      bondEscrowWorker.resetCircuitBreaker();
      marketCacheManager.stop();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
