/**
 * Soroban contract error code mappings.
 * Error codes 21–28 correspond to application-level contract errors.
 */

export interface ContractErrorInfo {
  message: string;
  resolution: string;
}

const CONTRACT_ERRORS: Record<number, ContractErrorInfo> = {
  21: {
    message: "Market has already expired",
    resolution: "This market is no longer accepting bets. Look for an active market.",
  },
  22: {
    message: "Market is not open for betting",
    resolution: "Betting is currently closed for this market. Please check back later.",
  },
  23: {
    message: "Bet amount is below the 1 XLM minimum",
    resolution: "Increase your bet to at least 1 XLM and try again.",
  },
  24: {
    message: "Outcome has already been submitted",
    resolution: "The outcome for this market has already been recorded.",
  },
  25: {
    message: "Challenge deadline has passed",
    resolution: "The window to challenge this outcome has closed.",
  },
  26: {
    message: "Insufficient bond provided",
    resolution: "Increase the bond amount to meet the minimum requirement.",
  },
  27: {
    message: "Unauthorized caller",
    resolution: "Your wallet does not have permission to perform this action.",
  },
  28: {
    message: "Payout already claimed",
    resolution: "This payout has already been collected for your wallet.",
  },
};

/**
 * Parse a raw Soroban error string such as `Error(Contract, #21)` and return
 * a human-friendly error info object, or `null` if the code is not recognised.
 *
 * @example
 * parseContractError("Error(Contract, #23)")
 * // → { message: "Bet amount is below the 1 XLM minimum", resolution: "..." }
 */
export function parseContractError(raw: string): ContractErrorInfo | null {
  // Match patterns like "Error(Contract, #21)" or "ContractError(21)"
  const match = raw.match(/(?:Error\(Contract,\s*#|ContractError\()(\d+)\)/);
  if (!match) return null;
  const code = parseInt(match[1], 10);
  return CONTRACT_ERRORS[code] ?? null;
}

/**
 * Look up a known contract error by numeric code.
 * Returns `null` for unknown codes.
 */
export function getContractError(code: number): ContractErrorInfo | null {
  return CONTRACT_ERRORS[code] ?? null;
}
