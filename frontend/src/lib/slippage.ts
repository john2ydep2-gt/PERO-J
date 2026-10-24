/**
 * Slippage calculation and protection utilities for parimutuel prediction markets.
 *
 * Prevents sandwiching and unexpected payout loss when rapid odds fluctuations
 * occur between transaction creation and contract execution.
 */

export const SLIPPAGE_PRESETS = [1, 5, 10] as const;
export const DEFAULT_SLIPPAGE_TOLERANCE = 1; // 1%
export const MAX_SLIPPAGE_TOLERANCE = 50; // 50%
export const BASIS_POINTS_DIVISOR = 10000;

/**
 * Calculate the minimum acceptable odds (in basis points) given current odds
 * and user-specified slippage tolerance percentage.
 *
 * @param currentOddsBps Current odds in basis points (e.g. 7000 for 70%)
 * @param slippageTolerancePercent Tolerance percentage (e.g. 1, 5, 10)
 * @returns Minimum acceptable odds in basis points (clamped to at least 1 bps)
 */
export function calculateMinOdds(
  currentOddsBps: number,
  slippageTolerancePercent: number
): number {
  if (currentOddsBps <= 0) return 1;
  const clampedTolerance = Math.max(0, Math.min(slippageTolerancePercent, 100));
  const minOdds = Math.floor(currentOddsBps * (1 - clampedTolerance / 100));
  return Math.max(1, Math.min(minOdds, currentOddsBps));
}

/**
 * Format basis points into human-readable percentage (e.g. 7000 bps -> "70.00%").
 */
export function formatOddsPercentage(bps: number): string {
  const percent = bps / 100;
  return `${percent.toFixed(2)}%`;
}

/**
 * Format odds in basis points into payout multiplier (e.g. 7000 bps -> "1.43x").
 */
export function formatOddsMultiplier(bps: number): string {
  if (bps <= 0) return "0.00x";
  const multiplier = BASIS_POINTS_DIVISOR / bps;
  return `${multiplier.toFixed(2)}x`;
}

/**
 * Returns true if the selected slippage tolerance is high (> 10%), warning of sandwich risks.
 */
export function isHighSlippage(slippageTolerancePercent: number): boolean {
  return slippageTolerancePercent > 10;
}
