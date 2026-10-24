import { useState, useEffect } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import NetworkStatusChip from "./NetworkStatusChip";

/**
 * Reads the stored or system theme preference.
 * Priority: localStorage → system prefers-color-scheme → "light"
 */
function getInitialTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  const stored = localStorage.getItem("theme") as "light" | "dark" | null;
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Applies the theme to the document root and persists to localStorage.
 */
function applyTheme(theme: "light" | "dark") {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);
}

type WalletId = "freighter" | "xbull" | "albedo" | "lobstr" | "walletconnect";

interface WalletOption {
  id: WalletId;
  name: string;
  icon: string;
  guide: string;
}

const WALLETS: WalletOption[] = [
  {
    id: "freighter",
    name: "Freighter",
    icon: "🚀",
    guide: "Install the Freighter browser extension, then unlock it and approve the connection.",
  },
  {
    id: "xbull",
    name: "xBull",
    icon: "🐂",
    guide: "Install the xBull extension or mobile app, then approve the connection request.",
  },
  {
    id: "albedo",
    name: "Albedo",
    icon: "🛡️",
    guide: "Albedo is web-based — no install needed. Approve the connection in the popup.",
  },
  {
    id: "lobstr",
    name: "Lobstr",
    icon: "🦞",
    guide: "Use the Lobstr mobile app and scan the WalletConnect QR code to connect.",
  },
  {
    id: "walletconnect",
    name: "WalletConnect",
    icon: "🔗",
    guide: "Scan the WalletConnect QR code with any compatible Stellar wallet.",
  },
];

const WALLET_STORAGE_KEY = "stellar.wallet.provider";

export default function Nav() {
  const [q, setQ] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState(() => {
    if (typeof window === "undefined") return "light";
    const stored = localStorage.getItem("theme");
    if (stored) return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const [wallet, setWallet] = useState<WalletId | null>(() => {
    if (typeof window === "undefined") return null;
    const stored = localStorage.getItem(WALLET_STORAGE_KEY);
    return stored && WALLETS.some((w) => w.id === stored) ? (stored as WalletId) : null;
  });
  const [walletError, setWalletError] = useState<string | null>(null);
  const nav = useNavigate();

  // Apply theme on mount and whenever it changes
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Keep in sync with system preference changes (e.g. user changes OS theme)
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (e: MediaQueryListEvent) => {
      // Only follow system if user hasn't overridden it
      const stored = localStorage.getItem("theme");
      if (!stored) {
        setTheme(e.matches ? "dark" : "light");
      }
    };
    mq.addEventListener("change", handleChange);
    return () => mq.removeEventListener("change", handleChange);
  }, []);

  function toggleTheme() {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }

  function search(e: React.FormEvent) {
    e.preventDefault();
    const v = q.trim();
    if (!v) return;
    if (v.startsWith("G") && v.length === 56) nav(`/wallet/${v}`);
    else nav(`/contract/${v}`);
    setQ("");
    setMenuOpen(false);
  }

  function connectWallet(id: WalletId) {
    const option = WALLETS.find((w) => w.id === id);
    if (!option) return;
    setWalletError(null);
    try {
      localStorage.setItem(WALLET_STORAGE_KEY, id);
      setWallet(id);
      setWalletModalOpen(false);
    } catch {
      setWalletError(`Unable to connect to ${option.name}. Make sure the wallet is installed and try again.`);
    }
  }

  function disconnectWallet() {
    localStorage.removeItem(WALLET_STORAGE_KEY);
    setWallet(null);
    setWalletError(null);
  }

  const activeWallet = wallet ? WALLETS.find((w) => w.id === wallet) : null;

  const linkStyle = (isActive: boolean) => ({
    fontWeight: 600,
    fontSize: 15,
    whiteSpace: "nowrap" as const,
    color: isActive ? "var(--accent)" : "inherit",
    borderBottom: isActive ? "2px solid var(--accent)" : "none",
    paddingBottom: isActive ? "4px" : "0px",
  });

  return (
    <header className="nav-header">
      <div className="nav-bar">
        <NavLink
          to="/"
          onClick={() => setMenuOpen(false)}
          aria-label="Soroban Explorer home"
          style={({ isActive }) => ({
            fontWeight: 700,
            fontSize: 16,
            whiteSpace: "nowrap",
            color: isActive ? "var(--accent)" : "inherit",
            borderBottom: isActive ? "2px solid var(--accent)" : "none",
            paddingBottom: isActive ? "4px" : "0px",
          })}
        >
          <span aria-hidden="true">⬡</span> Soroban Explorer
        </NavLink>
        <button
          type="button"
          className="nav-toggle"
          aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
          aria-expanded={menuOpen}
          aria-controls="primary-navigation"
          onClick={() => setMenuOpen((o) => !o)}
        >
          <span aria-hidden="true">☰</span>
        </button>
        <nav id="primary-navigation" aria-label="Primary" className={`nav-links${menuOpen ? " open" : ""}`}>
          <NavLink to="/contracts" onClick={() => setMenuOpen(false)} style={({ isActive }) => linkStyle(isActive)}>
            Contracts
          </NavLink>
          <form onSubmit={search} className="nav-search" role="search">
            <label htmlFor="nav-search-input" className="sr-only">
              Search contract ID or wallet address
            </label>
            <input
              id="nav-search-input"
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Search contract ID or wallet address…"
              style={{ flex: 1, minWidth: 0 }}
            />
            <button type="submit">Search</button>
          </form>
          <NetworkStatusChip sseUrl="/api/events/stream" />
          <button type="button" onClick={toggleTheme} aria-label="Toggle dark mode" className="nav-theme">
            {theme === "dark" ? "Light" : "Dark"}
          </button>
        </nav>
      </div>
      {walletModalOpen && (
        <div
          className="wallet-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Select a Stellar wallet"
          onClick={() => setWalletModalOpen(false)}
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
            className="wallet-modal"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--bg, #fff)",
              color: "inherit",
              borderRadius: 12,
              padding: 20,
              width: "min(420px, 92vw)",
              maxHeight: "85vh",
              overflowY: "auto",
              boxShadow: "0 10px 40px rgba(0,0,0,0.3)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 18 }}>Connect a Stellar wallet</h3>
              <button type="button" aria-label="Close" onClick={() => setWalletModalOpen(false)}>
                ✕
              </button>
            </div>
            {walletError && (
              <p role="alert" style={{ color: "#d33", fontSize: 13, marginTop: 0 }}>
                {walletError}
              </p>
            )}
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
              {WALLETS.map((w) => (
                <li key={w.id}>
                  <button
                    type="button"
                    onClick={() => connectWallet(w.id)}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      display: "flex",
                      gap: 12,
                      alignItems: "flex-start",
                      padding: 12,
                      borderRadius: 8,
                      border: "1px solid var(--border, #ddd)",
                      background: "transparent",
                      color: "inherit",
                      cursor: "pointer",
                    }}
                  >
                    <span aria-hidden="true" style={{ fontSize: 22 }}>{w.icon}</span>
                    <span>
                      <strong style={{ display: "block", fontSize: 15 }}>{w.name}</strong>
                      <span style={{ fontSize: 12, opacity: 0.75 }}>{w.guide}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </header>
  );
}
