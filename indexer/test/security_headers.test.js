import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { securityHeaders } from "../src/middleware/securityHeaders.js";
import { createCorsMiddleware } from "../src/middleware/cors.js";

function createMockRes() {
  const headers = {};
  return {
    headers,
    statusCode: 200,
    setHeader(name, value) {
      headers[name.toLowerCase()] = value;
    },
    removeHeader(name) {
      delete headers[name.toLowerCase()];
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    end() {},
    json(data) {
      this.body = data;
      return this;
    },
  };
}

describe("Security Headers Policy (Observatory A+)", () => {
  it("sets all required security headers", () => {
    const req = { headers: {} };
    const res = createMockRes();
    res.setHeader("X-Powered-By", "Express");
    let calledNext = false;

    securityHeaders(req, res, () => {
      calledNext = true;
    });

    assert.equal(calledNext, true);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["x-frame-options"], "DENY");
    assert.match(res.headers["strict-transport-security"], /max-age=31536000.*preload/);
    assert.match(res.headers["content-security-policy"], /default-src 'self'/);
    assert.match(res.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.equal(res.headers["referrer-policy"], "strict-origin-when-cross-origin");
    assert.equal(res.headers["x-powered-by"], undefined);
  });
});

describe("CORS Allowlist Policy", () => {
  it("allows requests from approved frontend origins", () => {
    const cors = createCorsMiddleware();
    const req = {
      method: "GET",
      headers: { origin: "http://localhost:5173" },
    };
    const res = createMockRes();
    let calledNext = false;

    cors(req, res, () => {
      calledNext = true;
    });

    assert.equal(calledNext, true);
    assert.equal(res.headers["access-control-allow-origin"], "http://localhost:5173");
    assert.equal(res.headers["access-control-allow-credentials"], "true");
  });

  it("handles OPTIONS preflight for allowed origin with 204", () => {
    const cors = createCorsMiddleware();
    const req = {
      method: "OPTIONS",
      headers: { origin: "https://drips.network" },
    };
    const res = createMockRes();
    let calledNext = false;

    cors(req, res, () => {
      calledNext = true;
    });

    assert.equal(calledNext, false);
    assert.equal(res.statusCode, 204);
    assert.equal(res.headers["access-control-allow-origin"], "https://drips.network");
  });

  it("blocks unapproved origin on preflight", () => {
    const cors = createCorsMiddleware();
    const req = {
      method: "OPTIONS",
      headers: { origin: "https://malicious-site.com" },
    };
    const res = createMockRes();

    cors(req, res, () => {});

    assert.equal(res.statusCode, 403);
    assert.equal(res.headers["access-control-allow-origin"], undefined);
  });

  it("passes through non-CORS requests without origin header", () => {
    const cors = createCorsMiddleware();
    const req = { method: "GET", headers: {} };
    const res = createMockRes();
    let calledNext = false;

    cors(req, res, () => {
      calledNext = true;
    });

    assert.equal(calledNext, true);
    assert.equal(res.headers["access-control-allow-origin"], undefined);
  });
});
