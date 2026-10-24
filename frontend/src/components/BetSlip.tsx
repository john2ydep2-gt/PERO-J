import { useState, useCallback } from "react";

// Protocol fee applied to all parimutuel payouts
const PROTOCOL_FEE = 0.02; // 2%

interface BetSlipProps {
  /** Current amount already in the pool (excluding this bet) */
  poolSize?: number;
  /** Total prize pool used in payout calculation */
  totalPool?: number;
  /** Market/outcome label displayed in the header */
  marketLabel?: string;
  /** Called when the user confirms the bet */
  onPlaceBet?: (stake: number) => void;
}

/**
 * Calculates the estimated payout using the parimutuel formula:
 *   payout = (stake / (pool + stake)) * totalPool * (1 - fee)
 */
function calcPayout(stake: number, pool: number, totalPool: number): number {
  if (stake <= 0 || pool + stake === 0) return 0;
  return (stake / (pool + stake)) * totalPool * (1 - PROTOCOL_FEE);
}

export default function BetSlip({
  poolSize = 1000,
  totalPool = 5000,
  marketLabel = "Outcome",
  onPlaceBet,
}: BetSlipProps) {
  const [stake, setStake] = useState<string>("10");
  const [isOpen, setIsOpen] = useState(false);
  const [placed, setPlaced] = useState(false);

  const stakeNum = parseFloat(stake) || 0;
  const payout = calcPayout(stakeNum, poolSize, totalPool);
  const profit = payout - stakeNum;
  const multiplier = stakeNum > 0 ? payout / stakeNum : 0;
  const roi = stakeNum > 0 ? (profit / stakeNum) * 100 : 0;
  const feeAmount = stakeNum > 0 ? (stakeNum / (poolSize + stakeNum)) * totalPool * PROTOCOL_FEE : 0;

  const isValid = stakeNum > 0 && stakeNum <= 100_000;

  const handleStakeChange = useCallback((value: string) => {
    // Allow only numeric input with up to 2 decimal places
    if (/^\d*\.?\d{0,2}$/.test(value) || value === "") {
      setStake(value);
      setPlaced(false);
    }
  }, []);

  const handleSliderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setStake(e.target.value);
    setPlaced(false);
  }, []);

  const handlePlaceBet = () => {
    if (!isValid) return;
    onPlaceBet?.(stakeNum);
    setPlaced(true);
  };

  // ── Mobile: rendered as a bottom drawer ──────────────────────────────────
  return (
    <>
      {/* Mobile trigger button — visible only on small screens */}
      <button
        type="button"
        className="bet-slip-trigger"
        onClick={() => setIsOpen(true)}
        aria-label="Open betting slip"
        aria-expanded={isOpen}
      >
        🎯 Place Bet
      </button>

      {/* Overlay backdrop for mobile drawer */}
      {isOpen && (
        <div
          className="bet-slip-backdrop"
          onClick={() => setIsOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Bet slip panel — sidebar on desktop, bottom drawer on mobile */}
      <aside
        className={`bet-slip${isOpen ? " bet-slip--open" : ""}`}
        aria-label="Betting slip"
      >
        {/* ── Header ─────────────────────────────────────────────────── */}
        <div className="bet-slip__header">
          <h3 className="bet-slip__title">Bet Slip</h3>
          <button
            type="button"
            className="bet-slip__close"
            onClick={() => setIsOpen(false)}
            aria-label="Close betting slip"
          >
            ✕
          </button>
        </div>

        {/* ── Market label ───────────────────────────────────────────── */}
        <div className="bet-slip__market">
          <span className="badge">{marketLabel}</span>
        </div>

        {/* ── Stake input ────────────────────────────────────────────── */}
        <div className="bet-slip__section">
          <label htmlFor="bet-stake" className="bet-slip__label">
            Stake (XLM)
          </label>
          <input
            id="bet-stake"
            type="number"
            min="0.01"
            max="100000"
            step="0.01"
            value={stake}
            onChange={(e) => handleStakeChange(e.target.value)}
            placeholder="Enter stake amount"
            className="bet-slip__input"
            aria-describedby="bet-stake-hint"
          />
          <span id="bet-stake-hint" className="bet-slip__hint">
            Min: 0.01 XLM · Max: 100,000 XLM
          </span>
        </div>

        {/* ── Slider ─────────────────────────────────────────────────── */}
        <div className="bet-slip__section">
          <label htmlFor="bet-slider" className="bet-slip__label">
            Quick select
          </label>
          <input
            id="bet-slider"
            type="range"
            min="1"
            max="1000"
            step="1"
            value={Math.min(stakeNum, 1000)}
            onChange={handleSliderChange}
            className="bet-slip__slider"
            aria-label="Stake amount slider"
          />
          <div className="bet-slip__slider-labels">
            <span>1</span>
            <span>250</span>
            <span>500</span>
            <span>750</span>
            <span>1,000</span>
          </div>
        </div>

        {/* ── Quick-select chips ─────────────────────────────────────── */}
        <div className="bet-slip__chips" role="group" aria-label="Quick stake amounts">
          {[10, 25, 50, 100, 250].map((amount) => (
            <button
              key={amount}
              type="button"
              className={`bet-slip__chip${stakeNum === amount ? " bet-slip__chip--active" : ""}`}
              onClick={() => { setStake(String(amount)); setPlaced(false); }}
              aria-pressed={stakeNum === amount}
            >
              {amount}
            </button>
          ))}
        </div>

        {/* ── Payout breakdown ───────────────────────────────────────── */}
        <div className="bet-slip__breakdown" aria-live="polite" aria-label="Payout breakdown">
          <div className="bet-slip__row">
            <span className="bet-slip__row-label">Pool size</span>
            <span className="bet-slip__row-value">
              {poolSize.toLocaleString()} XLM
            </span>
          </div>
          <div className="bet-slip__row">
            <span className="bet-slip__row-label">Your share</span>
            <span className="bet-slip__row-value">
              {stakeNum > 0
                ? ((stakeNum / (poolSize + stakeNum)) * 100).toFixed(2) + "%"
                : "—"}
            </span>
          </div>
          <div className="bet-slip__row">
            <span className="bet-slip__row-label">Protocol fee (2%)</span>
            <span className="bet-slip__row-value bet-slip__row-value--muted">
              {feeAmount > 0 ? `−${feeAmount.toFixed(4)} XLM` : "—"}
            </span>
          </div>

          <div className="bet-slip__divider" />

          <div className="bet-slip__row bet-slip__row--highlight">
            <span className="bet-slip__row-label">Estimated payout</span>
            <span className="bet-slip__row-value bet-slip__row-value--accent">
              {payout > 0 ? `${payout.toFixed(4)} XLM` : "—"}
            </span>
          </div>
          <div className="bet-slip__row">
            <span className="bet-slip__row-label">Net profit</span>
            <span
              className={`bet-slip__row-value${
                profit > 0
                  ? " bet-slip__row-value--green"
                  : profit < 0
                  ? " bet-slip__row-value--red"
                  : ""
              }`}
            >
              {profit !== 0
                ? `${profit >= 0 ? "+" : ""}${profit.toFixed(4)} XLM`
                : "—"}
            </span>
          </div>
          <div className="bet-slip__row">
            <span className="bet-slip__row-label">Multiplier</span>
            <span className="bet-slip__row-value">
              {multiplier > 0 ? `${multiplier.toFixed(2)}×` : "—"}
            </span>
          </div>
          <div className="bet-slip__row">
            <span className="bet-slip__row-label">ROI</span>
            <span
              className={`bet-slip__row-value${
                roi > 0
                  ? " bet-slip__row-value--green"
                  : roi < 0
                  ? " bet-slip__row-value--red"
                  : ""
              }`}
            >
              {roi !== 0 ? `${roi >= 0 ? "+" : ""}${roi.toFixed(2)}%` : "—"}
            </span>
          </div>
        </div>

        {/* ── Place bet button ───────────────────────────────────────── */}
        <button
          type="button"
          className="bet-slip__cta"
          disabled={!isValid || placed}
          onClick={handlePlaceBet}
          aria-disabled={!isValid || placed}
        >
          {placed
            ? "✓ Bet Placed!"
            : isValid
            ? `Place Bet — ${stakeNum.toLocaleString()} XLM`
            : "Enter a valid stake"}
        </button>

        {placed && (
          <p className="bet-slip__confirm" role="status">
            Your bet of {stakeNum.toLocaleString()} XLM has been submitted.
          </p>
        )}
      </aside>
    </>
  );
}
