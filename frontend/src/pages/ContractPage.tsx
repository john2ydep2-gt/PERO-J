import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../api";
import EventTable from "../components/EventTable";
import Skeleton from "../components/Skeleton";
import CopyButton from "../components/CopyButton";

export default function ContractPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();

  const { data: meta, isLoading: metaLoading } = useQuery({
    queryKey: ["contract", id],
    queryFn: () => api.contract(id),
    enabled: !!id,
  });

  const { data: eventsData, isLoading: evLoading } = useQuery({
    queryKey: ["events", id],
    queryFn: () => api.events({ contract: id }),
    enabled: !!id && !!meta,
  });
  const events = eventsData?.events ?? [];

  // Invalidate contract cache after a successful registration so the page
  // reflects the new metadata immediately without waiting for staleTime to expire.
  const registerMutation = useMutation({
    mutationFn: api.registerContract,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["contract", id] });
    },
  });

  if (metaLoading) return <div className="card"><Skeleton rows={3} /></div>;
  if (!meta) return <p>Contract not found.</p>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div className="card">
        <h2 style={{ marginBottom: 8 }}>{meta.name}</h2>
        <p style={{ color: "var(--muted)", marginBottom: 12 }}>{meta.description}</p>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start", justifyContent: "space-between", marginBottom: 12 }}>
          <code style={{ fontSize: 12, color: "var(--muted)", wordBreak: "break-all", flex: 1 }}>{id}</code>
          <CopyButton value={id} size="small" ariaLabel="Copy contract ID" />
        </div>
        {meta.registered_by && (
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
            Registered by <code style={{ fontFamily: "monospace" }}>{meta.registered_by}</code>
          </div>
        )}
        {meta.created_at && (
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
            Created on {new Date(meta.created_at).toUTCString()}
          </div>
        )}

        {meta.functions.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <h3 style={{ marginBottom: 8, fontSize: 14 }}>Functions</h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {meta.functions.map(f => (
                <Link 
                  key={f.name} 
                  to={`/?contract=${id}&fn=${f.name}`}
                  style={{ textDecoration: "none" }}
                >
                  <div className="card" style={{ padding: "8px 12px", cursor: "pointer", transition: "background 0.2s" }} onMouseEnter={(e) => {
                    const el = e.currentTarget as HTMLElement;
                    el.style.backgroundColor = "var(--border)";
                  }} onMouseLeave={(e) => {
                    const el = e.currentTarget as HTMLElement;
                    el.style.backgroundColor = "";
                  }}>
                    <span className="badge">{f.name}</span>
                    <span style={{ marginLeft: 8, color: "var(--muted)" }}>{f.description}</span>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Re-register button: triggers cache invalidation so updated metadata
            is reflected immediately rather than waiting for staleTime to expire. */}
        <button
          style={{ marginTop: 16 }}
          disabled={registerMutation.isPending}
          onClick={() => registerMutation.mutate(meta)}
        >
          {registerMutation.isPending ? "Saving…" : "Update registration"}
        </button>
        {registerMutation.isError && (
          <p style={{ color: "red", marginTop: 8 }}>
            {(registerMutation.error as Error).message}
          </p>
        )}
        {registerMutation.isSuccess && (
          <p style={{ color: "green", marginTop: 8 }}>Registration updated.</p>
        )}
      </div>

      <h3>Recent Events</h3>
      <div className="card">
        {evLoading ? <Skeleton /> : <EventTable events={events} />}
      </div>
    </div>
  );
}
