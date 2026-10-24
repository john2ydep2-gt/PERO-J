import type { Bet } from "./types";

export function BetStatusBadge({ bet }: { bet: Bet }) {
  if (bet.phase === "confirmed") {
    return (
      <span className="badge green">
        Confirmed{bet.ledger != null ? ` · #${bet.ledger.toLocaleString()}` : ""}
      </span>
    );
  }
  return (
    <span className="badge pending">
      <span className="spinner" aria-hidden="true" />
      Pending
    </span>
  );
}

export default function BetRow({ bet }: { bet: Bet }) {
  return (
    <div className="bet-row">
      <div style={{ flex: 1, minWidth: 180 }}>
        <div style={{ fontWeight: 600 }}>{bet.market}</div>
        <div style={{ color: "var(--muted)", fontSize: 12 }}>
          Selection: {bet.selection} · Odds {bet.odds.toFixed(2)} · Stake {bet.stake}
        </div>
      </div>
      {bet.txHash && (
        <code
          title={bet.txHash}
          style={{ fontSize: 11, color: "var(--muted)", wordBreak: "break-all" }}
        >
          {bet.txHash.slice(0, 10)}…
        </code>
      )}
      <BetStatusBadge bet={bet} />
    </div>
  );
}
