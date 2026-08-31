/**
 * Tests for src/decoder.js
 *
 * decoder.js depends on:
 *  - db.getContractMeta (mocked via monkey-patch of the live db export)
 *  - detectSac from sac.js (real — XLM SAC contract ID is deterministic on testnet)
 *  - scValToNative from @stellar/stellar-sdk (real)
 *
 * Each test uses a UNIQUE contractId so the internal LRU cache (60s TTL)
 * never carries a stale null from a prior test into a test that expects ABI data.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { xdr, StrKey, Networks, Asset, Contract } from "@stellar/stellar-sdk";

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal raw event object matching the shape decode() expects.
 * topic[0] is always the function name symbol; remaining topics are args.
 */
function makeRawEvent(contractId, fnSymbol, extraTopics = [], dataVal = xdr.ScVal.scvVoid()) {
  return {
    contractId,
    topic: [xdr.ScVal.scvSymbol(fnSymbol), ...extraTopics],
    value: dataVal,
    ledger: 100,
    txHash: "aabbccdd",
  };
}

// Deterministic test addresses (seed = 32 bytes of 0x01 / 0x02)
const ADDR_G  = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";
const ADDR_G2 = "GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U";

function scAddress(gAddr) {
  return xdr.ScVal.scvAddress(
    xdr.ScAddress.scAddressTypeAccount(
      xdr.AccountId.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(gAddr))
    )
  );
}

// XLM SAC contract ID on Testnet (deterministic)
const XLM_SAC_ID = new Contract(
  Asset.native().contractId(Networks.TESTNET)
).contractId();

// Unique valid contract IDs (derived from deterministic seeds) — one per test
// so that the 60-second LRU cache in decoder.js never bleeds between tests.
const [C1, C2, C3, C4, C5, C6, C7, C8, C9, C10, C11, C12, C13, C14, C15, C16, C17] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
].map((i) => StrKey.encodeContract(Buffer.alloc(32, i)));


// ── mock setup ────────────────────────────────────────────────────────────────
// Import db first, replace getContractMeta, then import decode.

import { db } from "../src/db.js";
import { decode, fmt } from "../src/decoder.js";


// ── tests ─────────────────────────────────────────────────────────────────────

describe("decode()", () => {
  it("returns all required DecodedEvent fields", async () => {
    db.getContractMeta = async () => null;
    const result = await decode(makeRawEvent(C1, "foo"));

    assert.equal(typeof result.contract_id, "string");
    assert.equal(typeof result.function, "string");
    assert.equal(typeof result.ledger, "number");
    assert.equal(typeof result.tx_hash, "string");
    assert.equal(typeof result.description, "string");
    assert.ok(Array.isArray(result.raw_topics));
    assert.equal(typeof result.raw_data, "string");
    assert.ok(Array.isArray(result.event_addresses));
  });

  it("uses genericDescription when no ABI is registered", async () => {
    db.getContractMeta = async () => null;
    const result = await decode(makeRawEvent(C2, "myFunc", [xdr.ScVal.scvString("arg1")]));

    assert.equal(result.function, "myFunc");
    assert.ok(result.description.includes("myFunc"), "description should contain function name");
  });

  it("re-checks a contract registered after an initial negative lookup", async () => {
    db.getContractMeta = async () => null;
    const ev = makeRawEvent(C13, "transfer", [scAddress(ADDR_G), scAddress(ADDR_G2)]);

    // First hit: contract not registered → generic description, negative cached.
    const first = await decode(ev);
    assert.ok(first.description.includes("transfer("), "unregistered contract should be generic");

    // Contract becomes registered in the DB during the cache window.
    db.getContractMeta = async (id) =>
      id === C13 ? { id: C13, name: "Token", functions: [{ name: "transfer" }] } : null;

    // Immediately after, the negative cache still holds → still generic.
    const stillGeneric = await decode(ev);
    assert.ok(
      stillGeneric.description.includes("transfer("),
      "negative cache should still be warm before its TTL expires"
    );

    // After the short negative-cache TTL expires, the now-registered ABI is used.
    await new Promise((r) => setTimeout(r, 2400));
    const redecoded = await decode(ev);
    assert.ok(redecoded.description.includes("transferred"), "registered ABI should now be used");
  });

  it("uses buildDescription for 'swap' when ABI is registered", async () => {
    db.getContractMeta = async (id) =>
      id === C3 ? { id: C3, name: "StellarSwap", functions: [{ name: "swap" }] } : null;

    const ev = makeRawEvent(C3, "swap", [
      scAddress(ADDR_G),
      xdr.ScVal.scvString("100"),
      xdr.ScVal.scvString("USDC"),
      xdr.ScVal.scvString("98"),
      xdr.ScVal.scvString("XLM"),
    ]);

    const result = await decode(ev);
    assert.equal(result.function, "swap");
    assert.ok(result.description.includes("swapped"), "description should say 'swapped'");
    assert.ok(result.description.includes("USDC"), "description should include USDC");
    assert.ok(result.description.includes("XLM"), "description should include XLM");
    assert.ok(result.description.includes("StellarSwap"), "description should include contract name");
  });

  it("uses buildDescription for 'transfer'", async () => {
    db.getContractMeta = async (id) =>
      id === C4 ? { id: C4, name: "Blend", functions: [{ name: "transfer" }] } : null;

    const ev = makeRawEvent(
      C4,
      "transfer",
      [scAddress(ADDR_G), scAddress(ADDR_G2)],
      xdr.ScVal.scvString("50")
    );

    const result = await decode(ev);
    assert.equal(result.function, "transfer");
    assert.ok(result.description.includes("transferred"), "description should say 'transferred'");
    assert.ok(result.description.includes("50"), "description should include amount");
  });

  it("uses buildDescription for 'mint'", async () => {
    db.getContractMeta = async (id) =>
      id === C5 ? { id: C5, name: "MintCo", functions: [{ name: "mint" }] } : null;

    const ev = makeRawEvent(C5, "mint", [
      scAddress(ADDR_G),
      xdr.ScVal.scvString("1000"),
      xdr.ScVal.scvString("TOKEN"),
    ]);

    const result = await decode(ev);
    assert.equal(result.function, "mint");
    assert.ok(result.description.includes("minted"), "description should say 'minted'");
  });

  it("uses buildDescription for 'burn'", async () => {
    db.getContractMeta = async (id) =>
      id === C6 ? { id: C6, name: "BurnCo", functions: [{ name: "burn" }] } : null;

    const ev = makeRawEvent(C6, "burn", [
      scAddress(ADDR_G),
      xdr.ScVal.scvString("500"),
      xdr.ScVal.scvString("TOKEN"),
    ]);

    const result = await decode(ev);
    assert.equal(result.function, "burn");
    assert.ok(result.description.includes("burned"), "description should say 'burned'");
  });

  it("uses buildDescription for 'approve'", async () => {
    db.getContractMeta = async (id) =>
      id === C13 ? { id: C13, name: "Token", functions: [{ name: "approve" }] } : null;

    const ev = makeRawEvent(C13, "approve", [scAddress(ADDR_G), scAddress(ADDR_G2)]);

    const result = await decode(ev);
    assert.equal(result.function, "approve");
    assert.ok(result.description.includes("approved"), "description should say 'approved'");
    assert.ok(result.description.includes("GCFIRY…"), "description should include from address");
    assert.ok(result.description.includes("GCATS5…"), "description should include spender address");
    assert.ok(result.description.includes("Token"), "description should include contract name");
  });

  it("uses buildDescription for 'supply'", async () => {
    db.getContractMeta = async (id) =>
      id === C9 ? { id: C9, name: "Blend", functions: [{ name: "supply" }] } : null;

    const ev = makeRawEvent(C9, "supply", [
      scAddress(ADDR_G),
      xdr.ScVal.scvString("USDC"),
      xdr.ScVal.scvString("500"),
    ]);

    const result = await decode(ev);
    assert.equal(result.function, "supply");
    assert.ok(result.description.includes("supplied"), "description should say 'supplied'");
    assert.ok(result.description.includes("500"), "description should include amount");
    assert.ok(result.description.includes("USDC"), "description should include asset");
    assert.ok(result.description.includes("Blend"), "description should include contract name");
  });

  it("uses buildDescription for 'borrow'", async () => {
    db.getContractMeta = async (id) =>
      id === C10 ? { id: C10, name: "Blend", functions: [{ name: "borrow" }] } : null;

    const ev = makeRawEvent(C10, "borrow", [
      scAddress(ADDR_G),
      xdr.ScVal.scvString("USDC"),
      xdr.ScVal.scvString("250"),
    ]);

    const result = await decode(ev);
    assert.equal(result.function, "borrow");
    assert.ok(result.description.includes("borrowed"), "description should say 'borrowed'");
    assert.ok(result.description.includes("250"), "description should include amount");
    assert.ok(result.description.includes("USDC"), "description should include asset");
    assert.ok(result.description.includes("Blend"), "description should include contract name");
  });

  it("uses buildDescription for 'repay'", async () => {
    db.getContractMeta = async (id) =>
      id === C11 ? { id: C11, name: "Blend", functions: [{ name: "repay" }] } : null;

    const ev = makeRawEvent(C11, "repay", [
      scAddress(ADDR_G),
      xdr.ScVal.scvString("USDC"),
      xdr.ScVal.scvString("250"),
    ]);

    const result = await decode(ev);
    assert.equal(result.function, "repay");
    assert.ok(result.description.includes("repaid"), "description should say 'repaid'");
    assert.ok(result.description.includes("250"), "description should include amount");
    assert.ok(result.description.includes("USDC"), "description should include asset");
    assert.ok(result.description.includes("Blend"), "description should include contract name");
  });

  it("uses buildDescription for 'liquidate'", async () => {
    db.getContractMeta = async (id) =>
      id === C12 ? { id: C12, name: "Blend", functions: [{ name: "liquidate" }] } : null;

    const ev = makeRawEvent(C12, "liquidate", [
      scAddress(ADDR_G),
      scAddress(ADDR_G2),
      xdr.ScVal.scvString("USDC"),
      xdr.ScVal.scvString("100"),
    ]);

    const result = await decode(ev);
    assert.equal(result.function, "liquidate");
    assert.ok(result.description.includes("liquidated"), "description should say 'liquidated'");
    assert.ok(result.description.includes("100"), "description should include amount");
    assert.ok(result.description.includes("USDC"), "description should include asset");
    assert.ok(result.description.includes("Blend"), "description should include contract name");
  });

  // #306 — stake / unstake
  it("uses buildDescription for 'stake'", async () => {
    db.getContractMeta = async (id) =>
      id === C17 ? { id: C17, name: "Blend", functions: [{ name: "stake" }] } : null;

    const ev = makeRawEvent(C17, "stake", [
      scAddress(ADDR_G),
      xdr.ScVal.scvString("200"),
      xdr.ScVal.scvString("BLND"),
    ]);

    const result = await decode(ev);
    assert.equal(result.function, "stake");
    assert.ok(result.description.includes("staked"), "description should say 'staked'");
    assert.ok(result.description.includes("200"), "description should include amount");
    assert.ok(result.description.includes("BLND"), "description should include token");
    assert.ok(result.description.includes("Blend"), "description should include contract name");
  });

  it("uses buildDescription for 'unstake'", async () => {
    db.getContractMeta = async (id) =>
      id === C14 ? { id: C14, name: "Blend", functions: [{ name: "unstake" }] } : null;

    const ev = makeRawEvent(C14, "unstake", [
      scAddress(ADDR_G),
      xdr.ScVal.scvString("150"),
      xdr.ScVal.scvString("BLND"),
    ]);

    const result = await decode(ev);
    assert.equal(result.function, "unstake");
    assert.ok(result.description.includes("unstaked"), "description should say 'unstaked'");
    assert.ok(result.description.includes("150"), "description should include amount");
    assert.ok(result.description.includes("BLND"), "description should include token");
    assert.ok(result.description.includes("Blend"), "description should include contract name");
  });

  // #307 — deposit / withdraw
  it("uses buildDescription for 'deposit'", async () => {
    db.getContractMeta = async (id) =>
      id === C15 ? { id: C15, name: "Blend", functions: [{ name: "deposit" }] } : null;

    const ev = makeRawEvent(C15, "deposit", [
      scAddress(ADDR_G),
      xdr.ScVal.scvString("1000"),
      xdr.ScVal.scvString("USDC"),
    ]);

    const result = await decode(ev);
    assert.equal(result.function, "deposit");
    assert.ok(result.description.includes("deposited"), "description should say 'deposited'");
    assert.ok(result.description.includes("1000"), "description should include amount");
    assert.ok(result.description.includes("USDC"), "description should include token");
    assert.ok(result.description.includes("Blend"), "description should include contract name");
    assert.ok(result.description.includes("into"), "description should say 'into'");
  });

  it("uses buildDescription for 'withdraw'", async () => {
    db.getContractMeta = async (id) =>
      id === C16 ? { id: C16, name: "Blend", functions: [{ name: "withdraw" }] } : null;

    const ev = makeRawEvent(C16, "withdraw", [
      scAddress(ADDR_G),
      xdr.ScVal.scvString("750"),
      xdr.ScVal.scvString("USDC"),
    ]);

    const result = await decode(ev);
    assert.equal(result.function, "withdraw");
    assert.ok(result.description.includes("withdrew"), "description should say 'withdrew'");
    assert.ok(result.description.includes("750"), "description should include amount");
    assert.ok(result.description.includes("USDC"), "description should include token");
    assert.ok(result.description.includes("Blend"), "description should include contract name");
    assert.ok(result.description.includes("from"), "description should say 'from'");
  });

  it("labels the contract as SAC when contractId matches XLM SAC", async () => {

    // XLM_SAC_ID is already in the SAC map — db returns null (no registered ABI)
    db.getContractMeta = async () => null;
    const ev = makeRawEvent(XLM_SAC_ID, "transfer", [
      scAddress(ADDR_G),
      xdr.ScVal.scvString("100"),
    ]);
    const result = await decode(ev);
    assert.equal(result.sac_asset, "XLM", "sac_asset should be XLM");
    assert.ok(
      result.description.includes("XLM") || result.description.includes("SAC"),
      "description should reference XLM or SAC"
    );
  });

  it("extracts G… addresses into event_addresses", async () => {
    db.getContractMeta = async () => null;
    const ev = makeRawEvent(C7, "transfer", [scAddress(ADDR_G)]);
    const result = await decode(ev);
    assert.ok(result.event_addresses.includes(ADDR_G), `expected ${ADDR_G} in event_addresses`);
  });

  it("falls back to 'unknown' function name when first topic is not a symbol/string", async () => {
    db.getContractMeta = async () => null;
    const ev = {
      contractId: C8,
      topic: [xdr.ScVal.scvI32(42)],
      value: xdr.ScVal.scvVoid(),
      ledger: 1,
      txHash: "deadbeef",
    };
    const result = await decode(ev);
    assert.equal(result.function, "unknown");
  });

  it("raw_topics is an array of strings", async () => {
    db.getContractMeta = async () => null;
    const result = await decode(makeRawEvent(C1, "check"));
    assert.ok(result.raw_topics.every((t) => typeof t === "string"));
  });

  it("genericDescription does not truncate a valid 56-char strkey", async () => {
    db.getContractMeta = async () => null;
    const ev = makeRawEvent(C8, "myFunc", [xdr.ScVal.scvString(ADDR_G)]);
    const result = await decode(ev);
    assert.ok(result.description.includes(ADDR_G), "valid strkey should not be truncated");
  });

  it("genericDescription does not truncate a 128-char non-address string", async () => {
    db.getContractMeta = async () => null;
    const longStr = "a b ".repeat(32);
    const ev = makeRawEvent(C8, "myFunc", [xdr.ScVal.scvString(longStr)]);
    const result = await decode(ev);
    assert.ok(result.description.includes(longStr), "128-char string should not be truncated");
  });

  it("genericDescription truncates a 129-char non-address string", async () => {
    db.getContractMeta = async () => null;
    const longStr = "c d ".repeat(32) + "e";
    const ev = makeRawEvent(C8, "myFunc", [xdr.ScVal.scvString(longStr)]);
    const result = await decode(ev);
    assert.ok(
      result.description.includes("…"),
      "129-char string should be truncated"
    );
    assert.ok(
      !result.description.includes(longStr),
      "129-char string full value should not appear"
    );
  });
});

describe("fmt()", () => {
  it("truncates valid 56-character G… public key to first6…last4 format", () => {
    const key = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";
    assert.equal(fmt(key), "GCFIRY…YOJR");
  });

  it("truncates valid 56-character C… contract address to first6…last4 format", () => {
    const contract = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    assert.equal(fmt(contract), "CDLZFC…CYSC");
  });

  it("returns non-address string 'swap' unchanged", () => {
    assert.equal(fmt("swap"), "swap");
  });

  it("returns number 123 as '123' unchanged", () => {
    assert.equal(fmt(123), "123");
  });

  it("returns short strings unchanged", () => {
    assert.equal(fmt("XLM"), "XLM");
    assert.equal(fmt("G123"), "G123");
  });

  it("returns non-matching 56-character string unchanged", () => {
    const nonAddr = "ABCDEFGHIJ1234567890123456789012345678901234567890123456";
    assert.equal(fmt(nonAddr), nonAddr);
  });
});

