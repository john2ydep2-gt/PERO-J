import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dispatchContractEvent, registerEventHandler } from "../src/router/registry.js";
import { parseBackfillArgs } from "../src/backfill.js";

describe("contract event registry", () => {
  it("routes registered domain/action handlers", async () => {
    const event = { contractId: "contract-a", topic: [{ sym: () => "claim" }] };
    let received;
    const unregister = registerEventHandler("contract-a", "claim", (value) => {
      received = value;
    });

    try {
      await dispatchContractEvent(event);
      assert.equal(received, event);
    } finally {
      unregister();
    }
  });

  it("warns with structured details before generic handling of unregistered events", async () => {
    const warnings = [];
    const event = {
      contractId: "unregistered-contract",
      topic: [{ sym: () => "oracle_submission" }],
      ledger: 42,
      txHash: "tx-42",
    };

    await dispatchContractEvent(event, {
      logger: { warn: (...args) => warnings.push(args) },
      decodeEvent: async () => ({ function: "oracle_submission", description: "decoded" }),
      submitOnchain: false,
      database: { upsertEvent: async () => {} },
    });

    assert.deepEqual(warnings[0], ["[router] Unregistered contract event", {
      domain: "unregistered-contract",
      action: "oracle_submission",
      ledger: 42,
      txHash: "tx-42",
      fallback: "decode-and-persist",
    }]);
  });
});

describe("backfill argument parsing", () => {
  it("accepts a required starting ledger and optional end ledger", () => {
    assert.deepEqual(parseBackfillArgs(["--from-ledger", "10", "--to-ledger=20"]), {
      fromLedger: 10,
      toLedger: 20,
    });
  });

  it("rejects reversed ledger ranges", () => {
    assert.throws(() => parseBackfillArgs(["--from-ledger", "20", "--to-ledger", "10"]));
  });
});