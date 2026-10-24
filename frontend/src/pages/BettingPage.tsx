import { useEffect } from "react";
import { useBets } from "../bets/BetsContext";
import BetRow from "../bets/BetRow";
import BetSlip from "../bets/BetSlip";

export default function BettingPage() {
  const { address, pendingBets } = useBets();

  useEffect(() => {
    document.title = "Place a Bet - Soroban Smart Block Explorer";
  }, []);

  const myBets = address ? pendingBets.filter((b) => b.address === address) : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <h1 style={{ fontSize: 22, marginBottom: 4 }}>Place a Bet</h1>
        <p style={{ color: "var(--muted)" }}>
          Sign a bet transaction and watch it update instantly — it is reconciled against the
          indexer once the transaction lands on-chain.
        </p>
      </div>

      <BetSlip />

      <div className="card">
        <h2 style={{ fontSize: 18, marginBottom: 12 }}>Your bets</h2>
        {myBets.length === 0 ? (
          <p style={{ color: "var(--muted)" }}>
            Bets you place appear here instantly, before ledger confirmation.
          </p>
        ) : (
          <div>
            {myBets.map((bet) => (
              <BetRow key={bet.id} bet={bet} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
