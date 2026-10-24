/**
 * Tests for oracle replay defenses, domain separation, and freshness checks.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import {
  DOMAIN_SEPARATOR,
  buildCanonicalAttestationMessage,
  verifyAndConsumeOracleAttestation,
  OracleVerificationError,
} from "../src/oracle.js";
import { db } from "../src/db.js";

describe("Oracle Replay Attack Defenses", () => {
  it("generates deterministic canonical message hash", () => {
    const payload1 = {
      domain: DOMAIN_SEPARATOR,
      chain_id: "testnet",
      market_id: "market-100",
      nonce: "nonce-abc-1",
      timestamp: 1700000000000,
      outcome: { winning_outcome: "YES" },
    };
    const payload2 = { ...payload1 };

    const hash1 = buildCanonicalAttestationMessage(payload1);
    const hash2 = buildCanonicalAttestationMessage(payload2);

    assert.equal(hash1.toString("hex"), hash2.toString("hex"));
  });

  it("rejects invalid domain separator", async () => {
    const keypair = Keypair.random();
    const payload = {
      domain: "WRONG_DOMAIN",
      chain_id: "testnet",
      market_id: "market-100",
      nonce: "nonce-1",
      timestamp: Date.now(),
      outcome: { winning_outcome: "YES" },
      provider_id: keypair.publicKey(),
      signature: "00".repeat(64),
    };

    await assert.rejects(
      async () => {
        await verifyAndConsumeOracleAttestation(payload);
      },
      (err) => {
        assert.ok(err instanceof OracleVerificationError);
        assert.equal(err.code, "INVALID_DOMAIN_SEPARATOR");
        return true;
      }
    );
  });

  it("rejects expired timestamps (> 5 minutes old)", async () => {
    const keypair = Keypair.random();
    const now = Date.now();
    const expiredTimestamp = now - 6 * 60 * 1000; // 6 minutes old

    const payload = {
      domain: DOMAIN_SEPARATOR,
      chain_id: "testnet",
      market_id: "market-100",
      nonce: "nonce-1",
      timestamp: expiredTimestamp,
      outcome: { winning_outcome: "YES" },
      provider_id: keypair.publicKey(),
      signature: "00".repeat(64),
    };

    await assert.rejects(
      async () => {
        await verifyAndConsumeOracleAttestation(payload, { now });
      },
      (err) => {
        assert.ok(err instanceof OracleVerificationError);
        assert.equal(err.code, "SIGNATURE_EXPIRED");
        return true;
      }
    );
  });

  it("rejects timestamps too far in the future", async () => {
    const keypair = Keypair.random();
    const now = Date.now();
    const futureTimestamp = now + 5 * 60 * 1000; // 5 minutes ahead

    const payload = {
      domain: DOMAIN_SEPARATOR,
      chain_id: "testnet",
      market_id: "market-100",
      nonce: "nonce-1",
      timestamp: futureTimestamp,
      outcome: { winning_outcome: "YES" },
      provider_id: keypair.publicKey(),
      signature: "00".repeat(64),
    };

    await assert.rejects(
      async () => {
        await verifyAndConsumeOracleAttestation(payload, { now });
      },
      (err) => {
        assert.ok(err instanceof OracleVerificationError);
        assert.equal(err.code, "TIMESTAMP_IN_FUTURE");
        return true;
      }
    );
  });

  it("rejects replayed nonce when already consumed in db", async () => {
    const keypair = Keypair.random();
    const now = Date.now();
    const nonce = "consumed-nonce-123";

    // Mock db.isNonceConsumed
    const originalIsConsumed = db.isNonceConsumed;
    db.isNonceConsumed = async (provider, n) => {
      if (provider === keypair.publicKey() && n === nonce) return true;
      return false;
    };

    try {
      const payload = {
        domain: DOMAIN_SEPARATOR,
        chain_id: "testnet",
        market_id: "market-100",
        nonce,
        timestamp: now,
        outcome: { winning_outcome: "YES" },
        provider_id: keypair.publicKey(),
        signature: "00".repeat(64),
      };

      await assert.rejects(
        async () => {
          await verifyAndConsumeOracleAttestation(payload, { now });
        },
        (err) => {
          assert.ok(err instanceof OracleVerificationError);
          assert.equal(err.code, "REPLAY_DETECTED");
          return true;
        }
      );
    } finally {
      db.isNonceConsumed = originalIsConsumed;
    }
  });

  it("verifies valid cryptographic signature and consumes nonce", async () => {
    const keypair = Keypair.random();
    const now = Date.now();
    const nonce = "fresh-nonce-999";

    const basePayload = {
      domain: DOMAIN_SEPARATOR,
      chain_id: "testnet",
      market_id: "market-100",
      nonce,
      timestamp: now,
      outcome: { winning_outcome: "YES", score: [2, 1] },
    };

    const hash = buildCanonicalAttestationMessage(basePayload);
    const signature = keypair.sign(hash).toString("hex");

    const fullPayload = {
      ...basePayload,
      provider_id: keypair.publicKey(),
      signature,
    };

    let recorded = null;
    const originalIsConsumed = db.isNonceConsumed;
    const originalRecord = db.recordOracleNonce;
    db.isNonceConsumed = async () => false;
    db.recordOracleNonce = async (args) => {
      recorded = args;
    };

    try {
      const result = await verifyAndConsumeOracleAttestation(fullPayload, { now });
      assert.equal(result.verified, true);
      assert.ok(recorded);
      assert.equal(recorded.nonce, nonce);
      assert.equal(recorded.provider_id, keypair.publicKey());
    } finally {
      db.isNonceConsumed = originalIsConsumed;
      db.recordOracleNonce = originalRecord;
    }
  });
});
