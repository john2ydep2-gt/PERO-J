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
const [C1, C2, C3, C4, C5, C6, C7, C8] = [1, 2, 3, 4, 5, 6, 7, 8].map((i) =>
  StrKey.encodeContract(Buffer.alloc(32, i))
);

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

    const ev = makeRawEvent(C4, "transfer", [
      scAddress(ADDR_G),
      scAddress(ADDR_G2),
      xdr.ScVal.scvString("50"),
      xdr.ScVal.scvString("USDC"),
    ]);

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

