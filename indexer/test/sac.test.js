import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Asset, Contract, Keypair, Networks } from "@stellar/stellar-sdk";
import { detectSac, sacLabel, reloadSacMap } from "../src/sac.js";

const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || Networks.TESTNET;
const NATIVE_CONTRACT_ID = new Contract(Asset.native().contractId(NETWORK_PASSPHRASE)).contractId();

const sampleIssuer = Keypair.random().publicKey();
const usdcAsset = new Asset("USDC", sampleIssuer);
const usdcContractId = new Contract(usdcAsset.contractId(NETWORK_PASSPHRASE)).contractId();

describe("sac", () => {
  const originalSacAssets = process.env.SAC_ASSETS;

  afterEach(() => {
    if (originalSacAssets !== undefined) {
      process.env.SAC_ASSETS = originalSacAssets;
    } else {
      delete process.env.SAC_ASSETS;
    }
    reloadSacMap();
  });

  it("detects native XLM SAC contract", () => {
    const res = detectSac(NATIVE_CONTRACT_ID);
    assert.deepEqual(res, { isSac: true, assetCode: "XLM" });
    assert.equal(sacLabel(NATIVE_CONTRACT_ID, "fallback"), "XLM");
  });

  it("returns isSac false for unknown contract IDs", () => {
    const unknownContract = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC3M";
    const res = detectSac(unknownContract);
    assert.deepEqual(res, { isSac: false, assetCode: null });
    assert.equal(sacLabel(unknownContract, "fallback"), "fallback");
  });

  it("reloads SAC map dynamically when SAC_ASSETS env var is updated", () => {
    // Before reload, USDC is not in SAC map
    assert.equal(detectSac(usdcContractId).isSac, false);

    // Update env var and reload SAC map
    process.env.SAC_ASSETS = JSON.stringify([{ code: "USDC", issuer: sampleIssuer }]);
    reloadSacMap();

    // After reload, USDC is recognised
    const res = detectSac(usdcContractId);
    assert.deepEqual(res, { isSac: true, assetCode: "USDC" });
    assert.equal(sacLabel(usdcContractId), "USDC");
  });

  it("handles malformed SAC_ASSETS JSON gracefully without throwing", () => {
    process.env.SAC_ASSETS = "invalid-json-string";
    assert.doesNotThrow(() => reloadSacMap());

    // Native XLM should still be recognised
    assert.equal(detectSac(NATIVE_CONTRACT_ID).isSac, true);
  });

  it("logs a console.error when SAC_ASSETS contains invalid JSON (#320)", () => {
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.join(" "));

    try {
      process.env.SAC_ASSETS = "not-valid-json";
      reloadSacMap();
    } finally {
      console.error = originalError;
    }

    assert.ok(
      errors.some((msg) => msg.includes("[sac] SAC_ASSETS is not valid JSON:")),
      `expected error log about invalid JSON, got: ${JSON.stringify(errors)}`
    );
  });

  it("includes the parse error message in the console.error log (#320)", () => {
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.join(" "));

    try {
      process.env.SAC_ASSETS = "{broken json";
      reloadSacMap();
    } finally {
      console.error = originalError;
    }

    // The error message should contain the JSON parse error text
    const log = errors.find((msg) => msg.includes("[sac] SAC_ASSETS is not valid JSON:"));
    assert.ok(log, "expected console.error with [sac] SAC_ASSETS prefix");
    // The error detail (from err.message) must be present, not empty
    const afterPrefix = log.split("[sac] SAC_ASSETS is not valid JSON:")[1] ?? "";
    assert.ok(
      afterPrefix.trim().length > 0,
      "expected the parse error message to be appended after the prefix"
    );
  });
});
