import { describe, it, expect } from "vitest";
import {
  calculateMinOdds,
  formatOddsPercentage,
  formatOddsMultiplier,
  isHighSlippage,
} from "../lib/slippage";

describe("Slippage Protection Calculations", () => {
  it("calculates minimum acceptable odds correctly for 1% slippage", () => {
    // Current odds 7000 bps (70%), 1% slippage => 7000 * 0.99 = 6930 bps (69.30%)
    const minOdds = calculateMinOdds(7000, 1);
    expect(minOdds).toBe(6930);
  });

  it("calculates minimum acceptable odds correctly for 5% slippage", () => {
    // Current odds 7000 bps (70%), 5% slippage => 7000 * 0.95 = 6650 bps (66.50%)
    const minOdds = calculateMinOdds(7000, 5);
    expect(minOdds).toBe(6650);
  });

  it("calculates minimum acceptable odds correctly for 10% slippage", () => {
    // Current odds 5000 bps (50%), 10% slippage => 5000 * 0.90 = 4500 bps (45.00%)
    const minOdds = calculateMinOdds(5000, 10);
    expect(minOdds).toBe(4500);
  });

  it("clamps slippage tolerance bounds", () => {
    expect(calculateMinOdds(5000, 0)).toBe(5000);
    expect(calculateMinOdds(5000, 100)).toBe(1);
    expect(calculateMinOdds(0, 5)).toBe(1);
  });

  it("formats odds percentage correctly", () => {
    expect(formatOddsPercentage(7000)).toBe("70.00%");
    expect(formatOddsPercentage(3333)).toBe("33.33%");
    expect(formatOddsPercentage(50)).toBe("0.50%");
  });

  it("formats odds multiplier correctly", () => {
    expect(formatOddsMultiplier(5000)).toBe("2.00x");
    expect(formatOddsMultiplier(10000)).toBe("1.00x");
    expect(formatOddsMultiplier(2500)).toBe("4.00x");
  });

  it("identifies high slippage warnings above 10%", () => {
    expect(isHighSlippage(1)).toBe(false);
    expect(isHighSlippage(5)).toBe(false);
    expect(isHighSlippage(10)).toBe(false);
    expect(isHighSlippage(10.1)).toBe(true);
    expect(isHighSlippage(15)).toBe(true);
  });
});
