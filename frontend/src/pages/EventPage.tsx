import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../api";
import Skeleton from "../components/Skeleton";
import CopyButton from "../components/CopyButton";

export default function EventPage() {
  const { seq = "0" } = useParams();

  const { data: ev, isLoading } = useQuery({
    queryKey: ["event", seq],
    queryFn: () => api.event(Number(seq)),
  });

  useEffect(() => {
    if (ev) {
      document.title = `Event #${ev.seq} - Soroban Smart Block Explorer`;
    } else {
      document.title = "Soroban Smart Block Explorer";
    }
  }, [ev]);

  if (isLoading) return <div className="card"><Skeleton variant="card" rows={4} /></div>;
  if (!ev) return <p>Event not found.</p>;

  const topics = ev.raw_topics ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h2>Event #{ev.seq}</h2>

      <div className="card" style={{ display: "grid", gap: 12 }}>
        <Row label="Description" value={ev.description} highlight />
        <Row label="Function"    value={ev.function} badge />
        <Row label="Ledger"      value={ev.ledger.toLocaleString()} />
        {ev.created_at && <Row label="Time" value={new Date(ev.created_at).toUTCString()} />}
        <Row label="Contract" value={<Link to={`/contract/${ev.contract_id}`}>{ev.contract_id}</Link>} action={<CopyButton value={ev.contract_id} size="small" />} />
        {ev.tx_hash && <Row label="Tx Hash" value={ev.tx_hash} mono action={<CopyButton value={ev.tx_hash} size="small" />} />}
        {ev.raw_topics.length > 0 && (
          <Row label="Topics" value={ev.raw_topics.join(", ")} mono />
        )}
      </div>
    </div>
  );
}

function Row({ label, value, highlight, badge, mono, action }: {
  label: string;
  value: React.ReactNode;
  highlight?: boolean;
  badge?: boolean;
  mono?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-start", justifyContent: "space-between" }}>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flex: 1 }}>
        <span style={{ color: "var(--muted)", minWidth: 100 }}>{label}</span>
        {badge
          ? <span className="badge green">{value}</span>
          : <span style={{
              fontWeight: highlight ? 600 : 400,
              fontFamily: mono ? "monospace" : undefined,
              fontSize: mono ? 12 : undefined,
              wordBreak: "break-all",
            }}>{value}</span>
        }
      </div>
      {action && <div style={{ whiteSpace: "nowrap" }}>{action}</div>}
    </div>
  );
}
