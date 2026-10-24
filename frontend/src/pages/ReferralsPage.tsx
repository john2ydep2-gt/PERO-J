import { useState, useEffect } from "react";

const REFERRAL_COMMISSION = 0.005; // 0.5% on referred bets

/**
 * Generates a referral URL from a wallet address.
 * Uses the current origin so it works across dev/staging/production.
 */
function makeReferralUrl(address: string): string {
  const base =
    typeof window !== "undefined" ? window.location.origin : "https://soroban-explorer.app";
  return `${base}/?ref=${encodeURIComponent(address)}`;
}

const SHARE_TEXT =
  "I'm using Soroban Explorer to track smart contract events on Stellar! Join via my referral link and we both earn rewards. 🚀";

function buildShareUrls(url: string) {
  const encoded = encodeURIComponent(url);
  const text = encodeURIComponent(SHARE_TEXT + " " + url);
  return {
    x: `https://x.com/intent/tweet?text=${text}`,
    telegram: `https://t.me/share/url?url=${encoded}&text=${encodeURIComponent(SHARE_TEXT)}`,
    whatsapp: `https://wa.me/?text=${text}`,
  };
}

export default function ReferralsPage() {
  const [address, setAddress] = useState("");
  const [earnings, setEarnings] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [inputError, setInputError] = useState("");

  // Update document title and OG meta tags when address changes
  useEffect(() => {
    document.title = "Referral Programme — Soroban Explorer";
  }, []);

  useEffect(() => {
    if (!address) return;
    const refUrl = makeReferralUrl(address);
    // Update canonical og:url dynamically
    let ogUrl = document.querySelector<HTMLMetaElement>('meta[property="og:url"]');
    if (!ogUrl) {
      ogUrl = document.createElement("meta");
      ogUrl.setAttribute("property", "og:url");
      document.head.appendChild(ogUrl);
    }
    ogUrl.setAttribute("content", refUrl);

    let ogTitle = document.querySelector<HTMLMetaElement>('meta[property="og:title"]');
    if (!ogTitle) {
      ogTitle = document.createElement("meta");
      ogTitle.setAttribute("property", "og:title");
      document.head.appendChild(ogTitle);
    }
    ogTitle.setAttribute(
      "content",
      `Join Soroban Explorer — Earn ${(REFERRAL_COMMISSION * 100).toFixed(1)}% on referred bets`
    );

    let ogDesc = document.querySelector<HTMLMetaElement>('meta[property="og:description"]');
    if (!ogDesc) {
      ogDesc = document.createElement("meta");
      ogDesc.setAttribute("property", "og:description");
      document.head.appendChild(ogDesc);
    }
    ogDesc.setAttribute("content", SHARE_TEXT);

    // Twitter card meta
    let twCard = document.querySelector<HTMLMetaElement>('meta[name="twitter:card"]');
    if (!twCard) {
      twCard = document.createElement("meta");
      twCard.setAttribute("name", "twitter:card");
      document.head.appendChild(twCard);
    }
    twCard.setAttribute("content", "summary_large_image");

    let twTitle = document.querySelector<HTMLMetaElement>('meta[name="twitter:title"]');
    if (!twTitle) {
      twTitle = document.createElement("meta");
      twTitle.setAttribute("name", "twitter:title");
      document.head.appendChild(twTitle);
    }
    twTitle.setAttribute(
      "content",
      `Join Soroban Explorer — Earn ${(REFERRAL_COMMISSION * 100).toFixed(1)}% on referred bets`
    );
  }, [address]);

  function validateAddress(val: string): boolean {
    // Stellar addresses are 56-character base32 strings starting with G
    if (!val.trim()) {
      setInputError("Please enter your wallet address.");
      return false;
    }
    if (!/^G[A-Z2-7]{55}$/.test(val.trim())) {
      setInputError("Enter a valid Stellar address (56 characters starting with G).");
      return false;
    }
    setInputError("");
    return true;
  }

  function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    if (!validateAddress(address)) return;
    // Simulate fetching on-chain referral earnings (mock for now)
    setEarnings(Math.random() * 50);
  }

  async function handleCopy() {
    const url = makeReferralUrl(address);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for browsers without clipboard API
      const ta = document.createElement("textarea");
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  const referralUrl = address ? makeReferralUrl(address) : "";
  const shareUrls = address ? buildShareUrls(referralUrl) : null;
  const hasValidAddress = /^G[A-Z2-7]{55}$/.test(address.trim());

  return (
    <div className="referrals-page">
      {/* Page header */}
      <div>
        <h1 style={{ fontSize: 22, marginBottom: 4 }}>Referral Programme</h1>
        <p style={{ color: "var(--muted)" }}>
          Earn{" "}
          <strong style={{ color: "var(--text)" }}>
            {(REFERRAL_COMMISSION * 100).toFixed(1)}%
          </strong>{" "}
          on every bet placed by users you refer. Share your unique referral link
          across social platforms and start earning rewards on-chain.
        </p>
      </div>

      {/* How it works */}
      <div className="card referrals-steps">
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>How it works</h2>
        <ol className="referrals-steps__list">
          <li>Enter your Stellar wallet address below.</li>
          <li>Copy or share your unique referral link.</li>
          <li>
            When a referred user places a bet, you automatically earn{" "}
            {(REFERRAL_COMMISSION * 100).toFixed(1)}% of their stake — paid
            on-chain with no manual claiming required.
          </li>
        </ol>
      </div>

      {/* Generator form */}
      <div className="card">
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Generate your referral link</h2>
        <form onSubmit={handleGenerate} noValidate>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <input
              id="referral-address"
              type="text"
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                if (inputError) validateAddress(e.target.value);
              }}
              placeholder="Your Stellar wallet address (G…)"
              aria-label="Stellar wallet address"
              aria-describedby={inputError ? "referral-error" : undefined}
              aria-invalid={!!inputError}
              style={{ flex: "1 1 300px", fontFamily: "monospace", fontSize: 12 }}
            />
            <button
              type="submit"
              style={{ minHeight: 48, padding: "0 20px", whiteSpace: "nowrap" }}
            >
              Generate Link
            </button>
          </div>
          {inputError && (
            <p
              id="referral-error"
              role="alert"
              style={{ color: "var(--red, #cf222e)", fontSize: 13, marginTop: 4 }}
            >
              {inputError}
            </p>
          )}
        </form>

        {/* Generated URL display */}
        {hasValidAddress && referralUrl && (
          <div style={{ marginTop: 16 }}>
            <label
              style={{
                display: "block",
                fontSize: 13,
                color: "var(--muted)",
                marginBottom: 6,
              }}
            >
              Your referral link
            </label>
            <div className="referral-url-box">
              <code className="referral-url-box__url">{referralUrl}</code>
              <button
                type="button"
                onClick={handleCopy}
                className="referral-url-box__copy"
                aria-label={copied ? "Link copied!" : "Copy referral link"}
                style={{ minHeight: 48, minWidth: 80 }}
              >
                {copied ? "✓ Copied!" : "Copy"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Social share buttons */}
      {hasValidAddress && shareUrls && (
        <div className="card">
          <h2 style={{ fontSize: 16, marginBottom: 12 }}>Share on social</h2>
          <p style={{ color: "var(--muted)", fontSize: 13, marginBottom: 16 }}>
            One-click sharing with pre-populated marketing copy and your link.
          </p>
          <div className="share-buttons">
            {/* X (Twitter) */}
            <a
              href={shareUrls.x}
              target="_blank"
              rel="noopener noreferrer"
              className="share-btn share-btn--x"
              aria-label="Share on X (Twitter)"
              style={{ minHeight: 48, display: "inline-flex", alignItems: "center" }}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
                style={{ marginRight: 8, flexShrink: 0 }}
              >
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
              Share on X
            </a>

            {/* Telegram */}
            <a
              href={shareUrls.telegram}
              target="_blank"
              rel="noopener noreferrer"
              className="share-btn share-btn--telegram"
              aria-label="Share on Telegram"
              style={{ minHeight: 48, display: "inline-flex", alignItems: "center" }}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
                style={{ marginRight: 8, flexShrink: 0 }}
              >
                <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
              </svg>
              Share on Telegram
            </a>

            {/* WhatsApp */}
            <a
              href={shareUrls.whatsapp}
              target="_blank"
              rel="noopener noreferrer"
              className="share-btn share-btn--whatsapp"
              aria-label="Share on WhatsApp"
              style={{ minHeight: 48, display: "inline-flex", alignItems: "center" }}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
                style={{ marginRight: 8, flexShrink: 0 }}
              >
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z" />
              </svg>
              Share on WhatsApp
            </a>
          </div>
        </div>
      )}

      {/* Earnings card */}
      {earnings !== null && hasValidAddress && (
        <div className="card referrals-earnings">
          <h2 style={{ fontSize: 16, marginBottom: 12 }}>Your referral earnings</h2>
          <div className="referrals-earnings__stat">
            <span className="referrals-earnings__amount">
              {earnings.toFixed(4)} XLM
            </span>
            <span style={{ color: "var(--muted)", fontSize: 13 }}>
              Total earned from referrals
            </span>
          </div>
          <p style={{ color: "var(--muted)", fontSize: 12, marginTop: 8 }}>
            Earnings are automatically distributed on-chain. No manual claiming
            required.
          </p>
        </div>
      )}
    </div>
  );
}
