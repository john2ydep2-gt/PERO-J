/**
 * Security headers middleware enforcing CSP, HSTS, X-Frame-Options,
 * nosniff, and least-privilege browser security policies.
 * Designed to achieve an A+ score on Mozilla Observatory audits.
 */

export function securityHeaders(req, res, next) {
  // Prevent MIME-sniffing
  res.setHeader("X-Content-Type-Options", "nosniff");

  // Prevent clickjacking by disallowing framing
  res.setHeader("X-Frame-Options", "DENY");

  // HTTP Strict Transport Security (HSTS): 1 year max age + subdomains + preload
  res.setHeader(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains; preload"
  );

  // Content Security Policy (CSP): Restrict script, frame, object, and connect sources
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://horizon-testnet.stellar.org https://soroban-testnet.stellar.org https://*.stellar.org; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; upgrade-insecure-requests;"
  );

  // Referrer and cross-origin isolation policies
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");

  // Remove fingerprinting headers
  res.removeHeader("X-Powered-By");

  next();
}

export default securityHeaders;
