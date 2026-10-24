import { useState } from "react";
import { Link } from "react-router-dom";
import { useToast } from "../components/Toast";
import { useBets } from "./BetsContext";

const MARKETS = [
  { id: "home", label: "Match Winner — Home", odds: 1.85 },
  { id: "draw", label: "Match Winner — Draw", odds: 3.4 },
  { id: "away", label: "Match Winner — Away", odds: 2.6 },
];

export default function BetSlip() {
  const { address, connecting, connect, placeBet, isSigning, hasPending } = useBets();
  const toast = useToast();
  const [marketId, setMarketId] = useState(MARKETS[0].id);
  const [stake, setStake] = useState("10");

  const market = MARKETS.find((m) => m.id === marketId) ?? MARKETS[0];
  const stakeValue = Number(stake);
  const stakeValid = /^\d+(\.\d{1,7})?$/.test(stake.trim()) && stakeValue > 0;
  const busy = isSigning || hasPending;
  const payout = stakeValid ? (stakeValue * market.odds).toFixed(2) : "—";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !stakeValid) return;
    if (!address) {
      try {
        await connect();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not connect to the wallet.");
      }
      return;
    }
    await placeBet({
      market: market.label,
      selection: marketId,
      odds: market.odds,
      stake: stake.trim(),
    });
  };

  const buttonLabel = !address
    ? connecting
      ? "Connecting…"
      : "Connect wallet to bet"
    : isSigning
    ? "Confirm in your wallet…"
    : hasPending
    ? "Bet pending…"
    : "Place bet";

  return (
    <form onSubmit={handleSubmit} className="card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 18 }}>Bet slip</h2>
        {address && (
          <span style={{ fontSize: 12, color: "var(--muted)", fontFamily: "monospace", wordBreak: "break-all" }}>
            {address.slice(0, 8)}…{address.slice(-6)} ·{" "}
            <Link to={`/wallet/${address}`}>View history</Link>
          </span>
        )}
      </div>

      <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        Market
        <select value={marketId} onChange={(e) => setMarketId(e.target.value)} disabled={busy}>
          {MARKETS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} — {m.odds.toFixed(2)}
            </option>
          ))}
        </select>
      </label>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "stretch" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 160px" }}>
          Stake
          <input
            type="text"
            inputMode="decimal"
            value={stake}
            onChange={(e) => setStake(e.target.value)}
            placeholder="10"
            disabled={busy}
          />
        </label>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 160px" }}>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>Odds</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 34 }}>
            {busy ? (
              <>
                <span className="spinner" aria-hidden="true" />
                <span style={{ fontSize: 13, color: "var(--muted)" }}>
                  {isSigning ? "Awaiting signature…" : "Pending confirmation…"}
                </span>
              </>
            ) : (
              <span style={{ fontWeight: 700, fontSize: 20 }}>{market.odds.toFixed(2)}</span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: "1 1 160px" }}>
          <span style={{ color: "var(--muted)", fontSize: 13 }}>Potential payout</span>
          <div style={{ display: "flex", alignItems: "center", minHeight: 34, fontWeight: 600 }}>
            {payout === "—" ? "—" : `${payout} XLM`}
          </div>
        </div>
      </div>

      {stake.trim() !== "" && !stakeValid && (
        <p style={{ color: "var(--red, #d1242f)", fontSize: 13 }}>
          Enter a positive stake with at most 7 decimal places.
        </p>
      )}

      <button type="submit" disabled={busy || (!address && connecting) || (!!address && !stakeValid)}>
        {buttonLabel}
      </button>
    </form>
  );
}
