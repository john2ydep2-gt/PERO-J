import { useNetworkStatus, type ConnectionStatus } from "../hooks/useNetworkStatus";

// ---------------------------------------------------------------------------
// Config per status
// ---------------------------------------------------------------------------

interface StatusConfig {
  label: string;
  dotColor: string;
  chipBg: string;
  chipColor: string;
  pulse: boolean;
  ariaLabel: string;
}

const STATUS_CONFIG: Record<ConnectionStatus, StatusConfig> = {
  live: {
    label: "Live",
    dotColor: "#3fb950",
    chipBg: "rgba(31,111,48,0.18)",
    chipColor: "#3fb950",
    pulse: false,
    ariaLabel: "Connection status: live",
  },
  reconnecting: {
    label: "Reconnecting…",
    dotColor: "#d29922",
    chipBg: "rgba(154,103,0,0.18)",
    chipColor: "#d29922",
    pulse: true,
    ariaLabel: "Connection status: reconnecting",
  },
  offline: {
    label: "Offline",
    dotColor: "#f85149",
    chipBg: "rgba(207,34,46,0.18)",
    chipColor: "#f85149",
    pulse: false,
    ariaLabel: "Connection status: offline",
  },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface NetworkStatusChipProps {
  /** SSE URL to monitor. Omit to rely on navigator.onLine only. */
  sseUrl?: string;
}

/**
 * Floating chip that shows the current connection state.
 * Green "Live" · Yellow pulsing "Reconnecting…" · Red "Offline"
 */
export default function NetworkStatusChip({ sseUrl }: NetworkStatusChipProps) {
  const status = useNetworkStatus(sseUrl);
  const cfg = STATUS_CONFIG[status];

  return (
    <>
      {cfg.pulse && (
        <style>{`
          @keyframes status-pulse {
            0%, 100% { opacity: 1; }
            50%       { opacity: 0.35; }
          }
        `}</style>
      )}
      <div
        role="status"
        aria-label={cfg.ariaLabel}
        title={cfg.ariaLabel}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 9px",
          borderRadius: 20,
          background: cfg.chipBg,
          color: cfg.chipColor,
          fontSize: 12,
          fontWeight: 600,
          userSelect: "none",
          whiteSpace: "nowrap",
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: cfg.dotColor,
            flexShrink: 0,
            animation: cfg.pulse ? "status-pulse 1.2s ease-in-out infinite" : undefined,
          }}
        />
        {cfg.label}
      </div>
    </>
  );
}
