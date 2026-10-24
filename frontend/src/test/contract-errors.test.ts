import { describe, it, expect } from "vitest";
import { parseContractError, getContractError } from "../lib/contract-errors";

describe("parseContractError", () => {
  it("parses Error(Contract, #21) format", () => {
    const result = parseContractError("Error(Contract, #21)");
    expect(result).not.toBeNull();
    expect(result!.message).toBe("Market has already expired");
  });

  it("parses all codes 21–28", () => {
    const expected: Record<number, string> = {
      21: "Market has already expired",
      22: "Market is not open for betting",
      23: "Bet amount is below the 1 XLM minimum",
      24: "Outcome has already been submitted",
      25: "Challenge deadline has passed",
      26: "Insufficient bond provided",
      27: "Unauthorized caller",
      28: "Payout already claimed",
    };
    for (const [code, message] of Object.entries(expected)) {
      const result = parseContractError(`Error(Contract, #${code})`);
      expect(result, `code ${code}`).not.toBeNull();
      expect(result!.message, `code ${code}`).toBe(message);
      expect(result!.resolution, `code ${code}`).toBeTruthy();
    }
  });

  it("returns null for unknown error code", () => {
    expect(parseContractError("Error(Contract, #99)")).toBeNull();
  });

  it("returns null for non-contract error strings", () => {
    expect(parseContractError("Network request failed")).toBeNull();
    expect(parseContractError("")).toBeNull();
  });

  it("parses ContractError(21) format", () => {
    const result = parseContractError("ContractError(21)");
    expect(result).not.toBeNull();
    expect(result!.message).toBe("Market has already expired");
  });
});

describe("getContractError", () => {
  it("returns info for known code", () => {
    const result = getContractError(27);
    expect(result).not.toBeNull();
    expect(result!.message).toBe("Unauthorized caller");
  });

  it("returns null for unknown code", () => {
    expect(getContractError(0)).toBeNull();
    expect(getContractError(99)).toBeNull();
  });
});
