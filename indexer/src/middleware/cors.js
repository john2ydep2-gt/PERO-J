/**
 * Strict CORS allowlist middleware.
 * Validates request origins against an approved allowlist.
 */

export function createCorsMiddleware(options = {}) {
  const defaultOrigins = [
    "http://localhost:3000",
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
    "https://drips.network",
  ];

  const envOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const allowedOrigins = [
    ...defaultOrigins,
    ...envOrigins,
    ...(options.allowedOrigins || []),
  ];

  return function corsMiddleware(req, res, next) {
    const origin = req.headers.origin;

    if (!origin) {
      // Direct same-origin or non-browser request
      return next();
    }

    const isAllowed = allowedOrigins.some((allowed) => {
      if (allowed === "*") return true;
      if (allowed.includes("*")) {
        const regex = new RegExp(
          "^" + allowed.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$"
        );
        return regex.test(origin);
      }
      return allowed.toLowerCase() === origin.toLowerCase();
    });

    if (isAllowed) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS"
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-Requested-With, X-Admin-Key"
      );
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Max-Age", "86400");
      res.setHeader("Vary", "Origin");
    }

    if (req.method === "OPTIONS") {
      if (isAllowed) {
        return res.status(204).end();
      }
      return res.status(403).json({ error: "CORS origin not allowed" });
    }

    next();
  };
}

export default createCorsMiddleware;
