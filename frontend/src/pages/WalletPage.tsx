import { useState, useEffect, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { StrKey } from "@stellar/stellar-sdk";
import { api } from "../api";
import { useBets } from "../bets/BetsContext";
import BetRow from "../bets/BetRow";
import EventTable from "../components/EventTable";
import Skeleton from "../components/Skeleton";

type WalletId = "freighter" | "xbull" | "albedo" | "lobstr" | "walletconnect";

interface WalletOption {
  id: WalletId;
  name: string;
  icon: string;
  guide: string;
  installUrl: string;
}

const WALLETS: WalletOption[] = [
  {
    id: "freighter",
    name: "Freighter",
    icon: "🚀",
    guide: "Install the Freighter browser extension, then unlock it and approve the connection request.",
    installUrl: "https://www.freighter.app/",
  },
  {
    id: "xbull",
    name: "xBull",
    icon: "🐂",
    guide: "Install the xBull extension or mobile app, then approve the connection request.",
    installUrl: "https://xbull.app/",
  },
  {
    id: "albedo",
    name: "Albedo",
    icon: "🛡️",
    guide: "Albedo is a web-based signer — no install needed. Approve the connection in the popup.",
    installUrl: "https://albedo.link/",
  },
  {
    id: "lobstr",
    name: "Lobstr",
    icon: "🦞",
    guide: "Use the Lobstr mobile app or extension and approve the connection request.",
    installUrl: "https://lobstr.co/",
  },
  {
    id: "walletconnect",
    name: "WalletConnect",
    icon: "🔗",
    guide: "Scan the WalletConnect QR code with a compatible mobile wallet to connect.",
    installUrl: "https://walletconnect.com/",
  },
];

const STORAGE_KEY = "soroban-explorer:wallet-provider";

function getInjectedProvider(id: WalletId): any | null {
  const w = window as any;
  switch (id) {
    case "freighter":
      return w.freighterApi ?? w.freighter ?? null;
    case "xbull":
      return w.xBull ?? w.xbull ?? null;
    case "albedo":
      return w.albedo ?? null;
    case "lobstr":
      return w.lobstr ?? null;
    case "walletconnect":
      return w.ethereum ?? null;
    default:
      return null;
  }
}

export default function WalletPage() {
  const { address = "" } = useParams();
  const navigate = useNavigate();
  const [searchInput, setSearchInput] = useState(address);
  const [page, setPage] = useState(1);

  const [selectorOpen, setSelectorOpen] = useState(false);
  const [activeWallet, setActiveWallet] = useState<WalletId | null>(null);
  const [connectedAddress, setConnectedAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<WalletId | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);

  useEffect(() => {
    document.title = address
      ? `Wallet ${address} - Soroban Smart Block Explorer`
      : "Wallet History - Soroban Smart Block Explorer";
  }, [address]);

  const connectWallet = useCallback(async (id: WalletId) => {
    setWalletError(null);
    setConnecting(id);
    try {
      const provider = getInjectedProvider(id);
      if (!provider) {
        const option = WALLETS.find(w => w.id === id);
        throw new Error(
          `${option?.name ?? id} is not installed. ${option?.guide ?? ""}`.trim()
        );
      }
      let publicKey: string | null = null;
      if (typeof provider.requestAccess === "function") {
        publicKey = await provider.requestAccess();
      } else if (typeof provider.connect === "function") {
        const res = await provider.connect();
        publicKey = typeof res === "string" ? res : res?.publicKey ?? null;
      } else if (typeof provider.getPublicKey === "function") {
        publicKey = await provider.getPublicKey();
      }
      if (!publicKey) {
        throw new Error("Wallet did not return a public key.");
      }
      setActiveWallet(id);
      setConnectedAddress(publicKey);
      localStorage.setItem(STORAGE_KEY, id);
      setSelectorOpen(false);
      navigate(`/wallet/${publicKey}`);
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : "Failed to connect wallet.");
    } finally {
      setConnecting(null);
    }
  }, [navigate]);

  // Auto-reconnect to the previously chosen wallet provider.
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY) as WalletId | null;
    if (saved && WALLETS.some(w => w.id === saved)) {
      void connectWallet(saved);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isValidAddress = StrKey.isValidEd25519PublicKey(address);

  const { data, isLoading } = useQuery({
    queryKey: ["wallet", address, page],
    queryFn: () => api.wallet(address, page),
    enabled: !!address && isValidAddress,
  });

  const events = data?.events ?? [];
  const total = data?.total ?? 0;
  const limit = data?.limit ?? 25;

  const { pendingBets } = useBets();
  const optimisticBets = useMemo(
    () =>
      pendingBets.filter(
        (bet) =>
          bet.address === address &&
          !events.some((ev) => ev.tx_hash && ev.tx_hash === bet.txHash)
      ),
    [address, events, pendingBets]
  );

  const handleSearch = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (searchInput.trim()) {
      navigate(`/wallet/${searchInput.trim()}`);
      setPage(1);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div className="card">
        <h2 style={{ marginBottom: 12 }}>Wallet History</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
          <button type="button" onClick={() => setSelectorOpen(true)}>
            {connectedAddress ? "Switch Wallet" : "Connect Wallet"}
          </button>
          {connectedAddress && (
            <code style={{ fontSize: 12, color: "var(--muted)", wordBreak: "break-all" }}>
              {activeWallet ? `${WALLETS.find(w => w.id === activeWallet)?.name}: ` : ""}
              {connectedAddress}
            </code>
          )}
        </div>
        <form onSubmit={handleSearch} style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input
            type="text"
            placeholder="Enter Stellar address"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            style={{ flex: 1, padding: "8px 12px", borderRadius: 4, border: "1px solid var(--border)", fontFamily: "monospace", fontSize: 12 }}
          />
          <button type="submit">Search</button>
        </form>
        {address && <code style={{ fontSize: 12, color: "var(--muted)", wordBreak: "break-all" }}>{address}</code>}
      </div>

      <div className="card">
        {!address
          ? <p style={{ color: "var(--muted)" }}>Enter a Stellar address to view wallet history.</p>
          : !isValidAddress
          ? <p style={{ color: "var(--muted)" }}>Invalid Stellar address.</p>
          : <>
              {optimisticBets.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  {optimisticBets.map((bet) => (
                    <BetRow key={bet.id} bet={bet} />
                  ))}
                </div>
              )}
              {isLoading
                ? <Skeleton />
                : <EventTable
                  events={events}
                  emptyMessage="No events found for this address."
                  emptySubtitle="This address has no indexed events."
                />}
            </>}
      </div>

      {/* Pagination */}
      {isValidAddress && (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
          <span style={{ padding: "6px 10px", color: "var(--muted)" }}>Page {page}</span>
          {/* Disable Next only when all events have been fetched.
              Checking page * limit >= total (not events.length < limit)
              avoids prematurely disabling the button when the last page
              is exactly full (total % limit === 0). */}
          <button disabled={page * limit >= total} onClick={() => setPage(p => p + 1)}>Next →</button>
        </div>
      )}

      {selectorOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Select a Stellar wallet"
          onClick={() => setSelectorOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <div
            className="card"
            onClick={e => e.stopPropagation()}
            style={{ width: "min(420px, 92vw)", display: "flex", flexDirection: "column", gap: 12 }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0 }}>Connect a Wallet</h3>
              <button type="button" onClick={() => setSelectorOpen(false)} aria-label="Close">✕</button>
            </div>
            {walletError && (
              <p style={{ color: "var(--danger, #e5484d)", fontSize: 12, margin: 0 }}>{walletError}</p>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {WALLETS.map(w => (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => void connectWallet(w.id)}
                  disabled={connecting !== null}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 12px",
                    textAlign: "left",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    background: "transparent",
                    cursor: connecting !== null ? "wait" : "pointer",
                  }}
                >
                  <span style={{ fontSize: 22 }} aria-hidden="true">{w.icon}</span>
                  <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <strong style={{ fontSize: 14 }}>
                      {w.name}{connecting === w.id ? " — connecting…" : ""}
                    </strong>
                    <span style={{ fontSize: 11, color: "var(--muted)" }}>{w.guide}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
