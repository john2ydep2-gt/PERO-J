import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getPoolConfig, createConnectionPool, getPoolMetrics } from "../../db/connection.js";
import { getPoolSize, db } from "../src/db.js";

describe("Database Connection Pool Tuning (#989)", () => {
  it("configures max: 25 for backend service by default", () => {
    const config = getPoolConfig("backend");
    assert.equal(config.max, 25);
    assert.equal(config.idleTimeoutMillis, 30000);
    assert.equal(config.connectionTimeoutMillis, 5000);
  });

  it("configures max: 10 for indexer service by default", () => {
    const config = getPoolConfig("indexer");
    assert.equal(config.max, 10);
    assert.equal(config.idleTimeoutMillis, 30000);
    assert.equal(config.connectionTimeoutMillis, 5000);
  });

  it("honors DATABASE_POOL_SIZE environment variable override", () => {
    const original = process.env.DATABASE_POOL_SIZE;
    try {
      process.env.DATABASE_POOL_SIZE = "15";
      const configBackend = getPoolConfig("backend");
      const configIndexer = getPoolConfig("indexer");
      assert.equal(configBackend.max, 15);
      assert.equal(configIndexer.max, 15);
    } finally {
      if (original === undefined) {
        delete process.env.DATABASE_POOL_SIZE;
      } else {
        process.env.DATABASE_POOL_SIZE = original;
      }
    }
  });

  it("registers an error event listener to prevent unhandled idle errors", () => {
    const pool = createConnectionPool("backend");
    assert.equal(pool.listenerCount("error") > 0, true);
  });

  it("reports accurate pool health metrics", () => {
    const fakePool = {
      totalCount: 5,
      idleCount: 3,
      waitingCount: 0,
      options: { max: 25 },
    };
    const metrics = getPoolMetrics(fakePool, 25);
    assert.equal(metrics.totalCount, 5);
    assert.equal(metrics.idleCount, 3);
    assert.equal(metrics.waitingCount, 0);
    assert.equal(metrics.max, 25);
    assert.equal(metrics.isHealthy, true);
  });

  it("flags unhealthy state when queries are queued and pool is saturated", () => {
    const saturatedPool = {
      totalCount: 25,
      idleCount: 0,
      waitingCount: 4,
      options: { max: 25 },
    };
    const metrics = getPoolMetrics(saturatedPool, 25);
    assert.equal(metrics.isHealthy, false);
  });

  it("db.getPoolMetrics() returns pool metrics object", () => {
    assert.equal(typeof db.getPoolMetrics, "function");
    const metrics = db.getPoolMetrics();
    assert.ok("totalCount" in metrics);
    assert.ok("idleCount" in metrics);
    assert.ok("waitingCount" in metrics);
    assert.ok("max" in metrics);
    assert.ok("isHealthy" in metrics);
  });
});
