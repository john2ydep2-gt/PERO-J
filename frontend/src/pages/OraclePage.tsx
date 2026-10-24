import { useState } from "react";
import CopyButton from "../components/CopyButton";

interface OracleRequest {
  id: string;
  contractId: string;
  title: string;
  feedType: string;
  requiredBond: number;
  rewardPool: number;
  status: "Open" | "InChallenge" | "Resolved";
  deadline: string;
}

interface SubmitterEntry {
  id: string;
  requestId: string;
  marketTitle: string;
  outcome: string;
  bondLocked: number;
  challengeWindow: string;
  status: "Unchallenged" | "Disputed" | "Finalized";
}

const INITIAL_REQUESTS: OracleRequest[] = [
  {
    id: "req-001",
    contractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    title: "StellarSwap Liquidity Pool Volatility Index (24h)",
    feedType: "Price & Volatility Feed",
    requiredBond: 1000,
    rewardPool: 250,
    status: "Open",
    deadline: "Ledger #5218900",
  },
  {
    id: "req-002",
    contractId: "CB6A3U3N64K7XQY5GZTYT7H4X4QWCEVRV2GHEW7TTR75H6N6Z3H4X5N6",
    title: "USDC Cross-Chain Bridge Settlement Latency Threshold",
    feedType: "Bridge Performance",
    requiredBond: 1500,
    rewardPool: 350,
    status: "Open",
    deadline: "Ledger #5219400",
  },
  {
    id: "req-003",
    contractId: "CAAA76N5Z4K7XQY5GZTYT7H4X4QWCEVRV2GHEW7TTR75H6N6Z3H4X5N6",
    title: "Phoenix Protocol Quarterly Reserve Verification",
    feedType: "Compliance Audit",
    requiredBond: 2000,
    rewardPool: 500,
    status: "InChallenge",
    deadline: "Ledger #5220100",
  },
];

const INITIAL_SUBMISSIONS: SubmitterEntry[] = [
  {
    id: "sub-101",
    requestId: "req-000",
    marketTitle: "Blend Protocol Collateral Invariant Check",
    outcome: "Healthy (142.5% Collateral Ratio)",
    bondLocked: 1000,
    challengeWindow: "48h remaining (Ledger #5217800)",
    status: "Unchallenged",
  },
];

export default function OraclePage() {
  const [requests, setRequests] = useState<OracleRequest[]>(INITIAL_REQUESTS);
  const [submissions, setSubmissions] = useState<SubmitterEntry[]>(INITIAL_SUBMISSIONS);
  const [activeReq, setActiveReq] = useState<OracleRequest | null>(null);
  const [outcomeVal, setOutcomeVal] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [alertMsg, setAlertMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const totalBondStaked = submissions.reduce((sum, s) => sum + s.bondLocked, 0);

  const handleOpenSubmit = (req: OracleRequest) => {
    setActiveReq(req);
    setOutcomeVal("");
    setEvidenceUrl("");
    setAlertMsg(null);
  };

  const handleClose = () => {
    setActiveReq(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeReq || !outcomeVal.trim()) return;

    setSubmitting(true);
    setTimeout(() => {
      const newEntry: SubmitterEntry = {
        id: `sub-${Math.floor(100 + Math.random() * 900)}`,
        requestId: activeReq.id,
        marketTitle: activeReq.title,
        outcome: outcomeVal.trim(),
        bondLocked: activeReq.requiredBond,
        challengeWindow: "72h remaining (43,200 ledgers)",
        status: "Unchallenged",
      };

      setSubmissions([newEntry, ...submissions]);
      setRequests(requests.map(r => r.id === activeReq.id ? { ...r, status: "InChallenge" } : r));
      setSubmitting(false);
      setActiveReq(null);
      setAlertMsg({
        type: "success",
        text: `Successfully submitted outcome for "${activeReq.title}". Bond of ${activeReq.requiredBond} PERO locked in escrow.`,
      });
    }, 400);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, padding: "20px 0" }}>
      <div>
        <h1 style={{ fontSize: 24, marginBottom: 6 }}>Oracle Submissions Portal</h1>
        <p style={{ color: "var(--muted)", maxWidth: 780 }}>
          Participate as an independent oracle submitter. Deposit collateral bonds, submit verified real-world
          outcomes for Soroban smart contracts, track active challenge windows, and earn protocol rewards.
        </p>
      </div>

      {alertMsg && (
        <div style={{
          padding: "12px 16px",
          borderRadius: 6,
          background: alertMsg.type === "success" ? "rgba(34, 197, 94, 0.15)" : "rgba(239, 68, 68, 0.15)",
          color: alertMsg.type === "success" ? "#16a34a" : "#dc2626",
          border: `1px solid ${alertMsg.type === "success" ? "#16a34a" : "#dc2626"}`,
        }}>
          {alertMsg.text}
        </div>
      )}

      {/* Submitter Metrics Summary */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16 }}>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 4 }}>Locked Bond Collateral</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{totalBondStaked.toLocaleString()} PERO</div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 4 }}>Earned Protocol Rewards</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "var(--accent)" }}>750 PERO</div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 4 }}>Submitter Reputation</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#16a34a" }}>99.2%</div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 4 }}>Active Submissions</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{submissions.length}</div>
        </div>
      </div>

      {/* Open Requests Table */}
      <div className="card" style={{ padding: 20 }}>
        <h2 style={{ fontSize: 18, marginBottom: 14 }}>Open Oracle Outcome Requests</h2>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", textAlign: "left", color: "var(--muted)" }}>
                <th style={{ padding: "8px 12px" }}>Title & Contract</th>
                <th style={{ padding: "8px 12px" }}>Type</th>
                <th style={{ padding: "8px 12px" }}>Required Bond</th>
                <th style={{ padding: "8px 12px" }}>Reward</th>
                <th style={{ padding: "8px 12px" }}>Deadline</th>
                <th style={{ padding: "8px 12px", textAlign: "right" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {requests.map(req => (
                <tr key={req.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "12px 12px" }}>
                    <div style={{ fontWeight: 600 }}>{req.title}</div>
                    <div style={{ fontSize: 12, color: "var(--muted)", display: "flex", alignItems: "center", gap: 4 }}>
                      <span>{req.contractId.slice(0, 8)}...{req.contractId.slice(-6)}</span>
                      <CopyButton value={req.contractId} />
                    </div>
                  </td>
                  <td style={{ padding: "12px 12px" }}>
                    <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, background: "rgba(99, 102, 241, 0.1)", color: "#6366f1" }}>
                      {req.feedType}
                    </span>
                  </td>
                  <td style={{ padding: "12px 12px" }}>{req.requiredBond} PERO</td>
                  <td style={{ padding: "12px 12px", color: "#16a34a", fontWeight: 600 }}>+{req.rewardPool} PERO</td>
                  <td style={{ padding: "12px 12px", color: "var(--muted)" }}>{req.deadline}</td>
                  <td style={{ padding: "12px 12px", textAlign: "right" }}>
                    <button
                      onClick={() => handleOpenSubmit(req)}
                      disabled={req.status !== "Open"}
                      style={{
                        padding: "6px 14px",
                        fontSize: 13,
                        fontWeight: 600,
                        cursor: req.status === "Open" ? "pointer" : "default",
                        opacity: req.status === "Open" ? 1 : 0.5,
                      }}
                    >
                      {req.status === "Open" ? "Submit Outcome" : "In Challenge"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* User Active Submissions & Challenge Windows */}
      <div className="card" style={{ padding: 20 }}>
        <h2 style={{ fontSize: 18, marginBottom: 14 }}>Your Submissions & Challenge Windows</h2>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", textAlign: "left", color: "var(--muted)" }}>
                <th style={{ padding: "8px 12px" }}>Market / Feed</th>
                <th style={{ padding: "8px 12px" }}>Proposed Outcome</th>
                <th style={{ padding: "8px 12px" }}>Bond Locked</th>
                <th style={{ padding: "8px 12px" }}>Challenge Window</th>
                <th style={{ padding: "8px 12px" }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {submissions.map(sub => (
                <tr key={sub.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "12px 12px", fontWeight: 600 }}>{sub.marketTitle}</td>
                  <td style={{ padding: "12px 12px" }}>{sub.outcome}</td>
                  <td style={{ padding: "12px 12px" }}>{sub.bondLocked} PERO</td>
                  <td style={{ padding: "12px 12px", color: "var(--muted)" }}>{sub.challengeWindow}</td>
                  <td style={{ padding: "12px 12px" }}>
                    <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, background: "rgba(34, 197, 94, 0.15)", color: "#16a34a" }}>
                      {sub.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Propose Outcome Modal */}
      {activeReq && (
        <div style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0, 0, 0, 0.6)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 100,
        }}>
          <div className="card" style={{ width: 480, padding: 24 }}>
            <h3 style={{ fontSize: 18, marginBottom: 8 }}>Submit Oracle Resolution</h3>
            <p style={{ fontSize: 13, color: "var(--muted)", marginBottom: 16 }}>{activeReq.title}</p>

            <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label style={{ display: "block", fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                  Verified Outcome / Data Point
                </label>
                <input
                  type="text"
                  placeholder="e.g. 142.50, Pass, SLA Met, 0x8a9f..."
                  value={outcomeVal}
                  onChange={e => setOutcomeVal(e.target.value)}
                  style={{ width: "100%", padding: "8px 10px" }}
                  required
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                  Evidence URI / IPFS CID
                </label>
                <input
                  type="text"
                  placeholder="ipfs://... or https://..."
                  value={evidenceUrl}
                  onChange={e => setEvidenceUrl(e.target.value)}
                  style={{ width: "100%", padding: "8px 10px" }}
                />
              </div>

              <div style={{ padding: 12, borderRadius: 6, background: "rgba(99, 102, 241, 0.08)", fontSize: 13 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Required Submitter Bond:</span>
                  <strong>{activeReq.requiredBond} PERO</strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", color: "#16a34a", marginTop: 4 }}>
                  <span>Reward Upon Finalization:</span>
                  <strong>+{activeReq.rewardPool} PERO</strong>
                </div>
                <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 6, margin: 0 }}>
                  Bond will be locked during the challenge window and returned upon resolution.
                </p>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 10 }}>
                <button type="button" onClick={handleClose} disabled={submitting}>Cancel</button>
                <button type="submit" disabled={submitting}>
                  {submitting ? "Locking Bond..." : "Deposit Bond & Submit"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
