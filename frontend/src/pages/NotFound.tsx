import { Link } from "react-router-dom";

export default function NotFound() {
  return (
    <div style={{ textAlign: "center", padding: "40px 20px" }}>
      <h1 style={{ fontSize: 48, marginBottom: 16 }}>404 — Page Not Found</h1>
      <p style={{ fontSize: 18, marginBottom: 24, color: "var(--muted)" }}>
        The page you are looking for does not exist. Please check the URL and try
        again.
      </p>
      <Link
        to="/"
        style={{
          display: "inline-block",
          padding: "10px 20px",
          background: "var(--accent)",
          color: "#0d1117",
          borderRadius: "6px",
          textDecoration: "none",
          fontWeight: 600,
        }}
      >
        Go to Home
      </Link>
    </div>
  );
}
