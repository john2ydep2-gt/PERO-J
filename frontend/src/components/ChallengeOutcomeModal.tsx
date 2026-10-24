import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

export interface ProposedOutcome {
  /** Unique identifier of the proposed outcome being challenged. */
  outcomeId: string;
  /** Contract the outcome belongs to (used for cache invalidation). */
  contractId: string;
  /** Human-readable description of the proposed outcome. */
  description: string;
  /** ISO timestamp of the dispute deadline. */
  deadline: string;
  /** Required disputer bond amount (in stroops or display units). */
  bondAmount: string;
  /** Reward paid out on a successful challenge. */
  payoutReward: string;
}

interface ChallengeOutcomeModalProps {
  outcome: ProposedOutcome;
  onClose: () => void;
  /** Optional signer; defaults to api.challengeOutcome. */
  onChallenge?: (outcomeId: string) => Promise<unknown>;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "00:00:00";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

export default function ChallengeOutcomeModal({
  outcome,
  onClose,
  onChallenge,
}: ChallengeOutcomeModalProps) {
  const queryClient = useQueryClient();
  const deadlineMs = useMemo(() => new Date(outcome.deadline).getTime(), [outcome.deadline]);
  const [now, setNow] = useState(() => Date.now());

  // Tick every second so the countdown stays live until the deadline.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const remainingMs = deadlineMs - now;
  const expired = remainingMs <= 0;

  const challengeMutation = useMutation({
    mutationFn: () =>
      onChallenge ? onChallenge(outcome.outcomeId) : api.challengeOutcome(outcome.outcomeId),
    onMutate: async () => {
      // Optimistic UI: mark the outcome as challenged immediately.
      await queryClient.cancelQueries({ queryKey: ["outcome", outcome.outcomeId] });
      const previous = queryClient.getQueryData(["outcome", outcome.outcomeId]);
      queryClient.setQueryData(["outcome", outcome.outcomeId], (old: any) =>
        old ? { ...old, challenged: true, status: "challenged" } : old
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(["outcome", outcome.outcomeId], context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["outcome", outcome.outcomeId] });
      queryClient.invalidateQueries({ queryKey: ["contract", outcome.contractId] });
    },
  });

  const handleChallenge = () => {
    if (expired || challengeMutation.isPending) return;
    challengeMutation.mutate();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="challenge-outcome-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ maxWidth: 480, width: "100%", display: "flex", flexDirection: "column", gap: 16 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <h2 id="challenge-outcome-title" style={{ margin: 0 }}>
            Challenge Proposed Outcome
          </h2>
          <button aria-label="Close" onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18 }}>
            ×
          </button>
        </div>

        <p style={{ color: "var(--muted)", margin: 0 }}>{outcome.description}</p>

        <div
          style={{
            textAlign: "center",
            padding: "16px 12px",
            borderRadius: 8,
            border: `1px solid ${expired ? "red" : "var(--border)"}`,
            background: expired ? "rgba(255,0,0,0.08)" : "var(--bg)",
          }}
        >
          <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 1, color: "var(--muted)", marginBottom: 4 }}>
            {expired ? "Challenge window closed" : "Time remaining to dispute"}
          </div>
          <div
            aria-live="polite"
            style={{
              fontFamily: "monospace",
              fontSize: 36,
              fontWeight: 700,
              color: expired ? "red" : "var(--fg)",
            }}
          >
            {formatRemaining(remainingMs)}
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
            Deadline: {new Date(outcome.deadline).toUTCString()}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "var(--muted)" }}>Required disputer bond</span>
            <strong>{outcome.bondAmount}</strong>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "var(--muted)" }}>Payout on successful challenge</span>
            <strong style={{ color: "green" }}>{outcome.payoutReward}</strong>
          </div>
        </div>

        {challengeMutation.isError && (
          <p style={{ color: "red", margin: 0 }}>
            {(challengeMutation.error as Error).message}
          </p>
        )}
        {challengeMutation.isSuccess && (
          <p style={{ color: "green", margin: 0 }}>Challenge submitted.</p>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} disabled={challengeMutation.isPending}>
            Cancel
          </button>
          <button
            onClick={handleChallenge}
            disabled={expired || challengeMutation.isPending || challengeMutation.isSuccess}
          >
            {challengeMutation.isPending
              ? "Signing…"
              : expired
              ? "Window closed"
              : "Sign & Challenge"}
          </button>
        </div>
      </div>
    </div>
  );
}
