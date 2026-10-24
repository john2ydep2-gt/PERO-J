import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { streamEvents } from "../api";
import { useToast } from "../components/Toast";
import {
  buildAndSignBet,
  networkPassphrase,
  sendBetTransaction,
  waitForConfirmation,
} from "./submit";
import { connectWallet, signTransactionXdr } from "./wallet";
import type { Bet, BetInput } from "./types";

export interface BetsApi {
  address: string | null;
  connecting: boolean;
  isSigning: boolean;
  pendingBets: Bet[];
  hasPending: boolean;
  connect: () => Promise<string>;
  placeBet: (input: BetInput) => Promise<void>;
}

const BetsContext = createContext<BetsApi | null>(null);

export function useBets(): BetsApi {
  const ctx = useContext(BetsContext);
  if (!ctx) throw new Error("useBets must be used within BetsProvider");
  return ctx;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return "Something went wrong while placing the bet.";
}

let betCounter = 0;

export function BetsProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [isSigning, setIsSigning] = useState(false);
  const [pendingBets, setPendingBets] = useState<Bet[]>([]);
  const toast = useToast();
  const queryClient = useQueryClient();

  const betsRef = useRef<Bet[]>(pendingBets);
  useEffect(() => {
    betsRef.current = pendingBets;
  }, [pendingBets]);

  const settledRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef(false);

  const settle = useCallback((id: string) => {
    if (settledRef.current.has(id)) return false;
    settledRef.current.add(id);
    return true;
  }, []);

  const removeBet = useCallback((id: string) => {
    setPendingBets((bets) => bets.filter((b) => b.id !== id));
  }, []);

  const patchBet = useCallback((id: string, patch: Partial<Bet>) => {
    setPendingBets((bets) => bets.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  }, []);

  const confirmBet = useCallback(
    (id: string, ledger?: number) => {
      if (!settle(id)) return;
      setPendingBets((bets) =>
        bets.map((b) => (b.id === id ? { ...b, phase: "confirmed" as const, ledger } : b))
      );
      const bet = betsRef.current.find((b) => b.id === id);
      if (bet) {
        toast.success(
          ledger != null
            ? `Bet confirmed in ledger #${ledger.toLocaleString()}.`
            : "Bet confirmed on-chain."
        );
        void queryClient.invalidateQueries({ queryKey: ["wallet", bet.address] });
        void queryClient.invalidateQueries({ queryKey: ["events"] });
      }
    },
    [queryClient, settle, toast]
  );

  const rollbackBet = useCallback(
    (id: string, message: string) => {
      if (settle(id)) removeBet(id);
      toast.error(message);
    },
    [removeBet, settle, toast]
  );

  useEffect(() => {
    const hasPending = pendingBets.some((b) => b.phase === "pending");
    if (!hasPending) return;
    const stop = streamEvents((event) => {
      if (!event.tx_hash) return;
      const match = betsRef.current.find(
        (b) => b.txHash === event.tx_hash && b.phase === "pending"
      );
      if (!match) return;
      confirmBet(match.id, event.ledger);
    });
    return stop;
  }, [confirmBet, pendingBets]);

  const connect = useCallback(async () => {
    setConnecting(true);
    try {
      const addr = await connectWallet();
      setAddress(addr);
      return addr;
    } finally {
      setConnecting(false);
    }
  }, []);

  const placeBet = useCallback(
    async (input: BetInput) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setIsSigning(true);
      let bet: Bet | null = null;
      let addr = address;
      try {
        if (!addr) addr = await connect();
        const { signed, server } = await buildAndSignBet({ ...input, address: addr }, (xdr) =>
          signTransactionXdr(xdr, addr!, networkPassphrase())
        );

        bet = {
          id: `bet-${Date.now()}-${betCounter++}`,
          address: addr,
          market: input.market,
          selection: input.selection,
          odds: input.odds,
          stake: input.stake,
          phase: "pending",
          createdAt: Date.now(),
        };
        const optimistic = bet;
        setPendingBets((bets) => [optimistic, ...bets]);
        setIsSigning(false);

        const hash = await sendBetTransaction(signed, server);
        patchBet(optimistic.id, { txHash: hash });

        try {
          const { ledger } = await waitForConfirmation(hash, server);
          confirmBet(optimistic.id, ledger);
        } catch (err) {
          rollbackBet(optimistic.id, errorMessage(err));
        }
      } catch (err) {
        setIsSigning(false);
        if (bet) {
          rollbackBet(bet.id, errorMessage(err));
        } else {
          toast.error(errorMessage(err));
        }
      } finally {
        setIsSigning(false);
        inFlightRef.current = false;
      }
    },
    [address, confirmBet, connect, patchBet, rollbackBet, toast]
  );

  const api = useMemo<BetsApi>(
    () => ({
      address,
      connecting,
      isSigning,
      pendingBets,
      hasPending: pendingBets.some((b) => b.phase === "pending"),
      connect,
      placeBet,
    }),
    [address, connect, connecting, isSigning, pendingBets, placeBet]
  );

  return <BetsContext.Provider value={api}>{children}</BetsContext.Provider>;
}
