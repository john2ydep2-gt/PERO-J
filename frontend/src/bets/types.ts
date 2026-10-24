export type BetPhase = "pending" | "confirmed";

export interface Bet {
  id: string;
  address: string;
  market: string;
  selection: string;
  odds: number;
  stake: string;
  phase: BetPhase;
  txHash?: string;
  ledger?: number;
  createdAt: number;
}

export interface BetInput {
  market: string;
  selection: string;
  odds: number;
  stake: string;
}
