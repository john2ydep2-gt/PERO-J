import BetSlip from "../components/BetSlip";

/**
 * BetSlipPage — demonstrates the interactive payout/ROI calculator widget.
 *
 * In a production integration, poolSize and totalPool would come from the
 * market's on-chain state, fetched via TanStack Query.
 */
export default function BetSlipPage() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <h1 style={{ fontSize: 22, marginBottom: 4 }}>Bet Placement</h1>
        <p style={{ color: "var(--muted)" }}>
          Enter your stake to see real-time payout and ROI calculations before
          confirming your bet.
        </p>
      </div>

      {/* Example market card */}
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h2 style={{ fontSize: 18, marginBottom: 4 }}>
              Will XLM exceed $1.00 by end of Q4 2026?
            </h2>
            <p style={{ color: "var(--muted)", fontSize: 13 }}>
              Prediction market · Closes 31 Dec 2026
            </p>
          </div>
          <span className="badge green">Open</span>
        </div>

        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 12,
        }}>
          <Stat label="Total pool"    value="5,000 XLM" />
          <Stat label="Yes pool"      value="3,200 XLM" />
          <Stat label="No pool"       value="1,800 XLM" />
          <Stat label="Participants"  value="142" />
        </div>
      </div>

      {/* Outcomes + bet slips side by side on desktop, stacked on mobile */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 340px",
        gap: 20,
        alignItems: "start",
      }}
        className="bet-layout"
      >
        {/* Outcome options */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <h3 style={{ fontSize: 16 }}>Select outcome</h3>
          <OutcomeCard
            label="Yes — XLM ≥ $1.00"
            pool={3200}
            selected
          />
          <OutcomeCard
            label="No — XLM < $1.00"
            pool={1800}
          />
        </div>

        {/* Bet slip widget */}
        <BetSlip
          poolSize={3200}
          totalPool={5000}
          marketLabel="Yes — XLM ≥ $1.00"
          onPlaceBet={(stake) => {
            console.info("Bet placed:", stake, "XLM");
          }}
        />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card" style={{ textAlign: "center" }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: "var(--accent)" }}>{value}</div>
      <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{label}</div>
    </div>
  );
}

function OutcomeCard({ label, pool, selected }: { label: string; pool: number; selected?: boolean }) {
  return (
    <div
      className="card"
      style={{
        border: selected ? "2px solid var(--accent)" : "1px solid var(--border-color)",
        cursor: "pointer",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "14px 16px",
        transition: "border-color 0.15s",
      }}
    >
      <span style={{ fontWeight: selected ? 700 : 400, color: selected ? "var(--accent)" : "var(--text-primary)" }}>
        {label}
      </span>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: 12, color: "var(--muted)" }}>Pool</div>
        <div style={{ fontWeight: 600 }}>{pool.toLocaleString()} XLM</div>
      </div>
    </div>
  );
}
