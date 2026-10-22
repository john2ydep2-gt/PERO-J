import express from "express";
import rateLimit from "express-rate-limit";
import { StrKey } from "@stellar/stellar-sdk";
import { db } from "./db.js";
import { fetchTokenMetadata } from "./sep41Metadata.js";
import { health } from "./index.js";
import { eventEmitter } from "./events.js";

const PORT = process.env.PORT || 3001;

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/**
 * Admin-key authentication middleware for privileged operations.
 * Reads the expected key from the API_ADMIN_KEY environment variable
 * and validates it against an Authorization: Bearer <key> header.
 */
const requireAdminKey = (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1] : null;
  const expected = process.env.API_ADMIN_KEY;
  if (!expected || !token || token !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

/**
 * Global Express error-handling middleware.
 * Logs the full stack trace together with the request method and path
 * so that unhandled errors are debuggable in production logs.
 *
 * @param {Error} err
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} _next
 */
export function errorHandler(err, req, res, _next) {
  console.error("API Error:", { method: req.method, path: req.path, stack: err.stack });
  if (res.headersSent) {
    return;
  }
  res.status(500).json({ error: err.message || "Internal Server Error" });
}

export function isValidStellarAddress(value) {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  return StrKey.isValidEd25519PublicKey(trimmed) || StrKey.isValidContract(trimmed);
}

/**
 * Validates the payload for registering/updating contract ABI metadata.
 *
 * @param {unknown} body
 * @returns {string|null} an error message when invalid, otherwise null
 */
export function validateContractPayload(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return "Request body must be a JSON object";
  }

  const { id, name, functions } = body;

  if (typeof id !== "string" || id.trim() === "") {
    return "id must be a non-empty string";
  }

  if (typeof name !== "string" || name.trim() === "") {
    return "name must be a non-empty string";
  }

  if (!Array.isArray(functions)) {
    return "functions must be an array";
  }

  return null;
}

export function createApp() {
  const app = express();
  let distinctFunctionsCache = null;
  app.use(express.json());

  // GET /health — liveness + readiness probe for container orchestrators and uptime monitors
  app.get(
    "/health",
    asyncHandler(async (req, res) => {
      const LAG_ALERT_THRESHOLD_S = Number(process.env.LAG_ALERT_THRESHOLD_S || 30);
      const now = Date.now();
      const uptimeSeconds = Math.floor((now - health.startedAt) / 1000);

      const dbConnected = await db.ping();

      let lagSeconds = null;
      if (health.lastIndexedAt !== null) {
        lagSeconds = Math.floor((now - health.lastIndexedAt) / 1000);
      }

      if (!dbConnected) {
        return res.status(503).json({
          status: "error",
          db: "disconnected",
          uptime_seconds: uptimeSeconds,
          lag_seconds: lagSeconds,
          last_ledger: health.lastLedger,
          last_indexed_at: health.lastIndexedAt
            ? new Date(health.lastIndexedAt).toISOString()
            : null,
        });
      }

      const degraded = lagSeconds !== null && lagSeconds > LAG_ALERT_THRESHOLD_S;
      const status = degraded ? "degraded" : "ok";

      const body = {
        status,
        db: "connected",
        uptime_seconds: uptimeSeconds,
        lag_seconds: lagSeconds,
        last_ledger: health.lastLedger,
        last_indexed_at: health.lastIndexedAt ? new Date(health.lastIndexedAt).toISOString() : null,
      };

      res.status(degraded ? 503 : 200).json(body);
    })
  );

  // GET /ready — readiness check for Kubernetes probes
  app.get(
    "/ready",
    asyncHandler(async (req, res) => {
      const dbConnected = await db.ping();
      if (!dbConnected) {
        return res.status(503).json({ status: "error", db: "disconnected" });
      }
      res.status(200).json({ status: "ok", db: "connected", last_ledger: health.lastLedger });
    })
  );

  // Rate limiter applies to /api/* routes to protect endpoints against DoS while exempting /health and /ready probes
  app.use(
    "/api",
    rateLimit({
      windowMs: 60_000,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
    })
  );

  // Legacy route redirect middleware: redirects /api/* (except /api/v1/*) to /api/v1/* with HTTP 301 (issue #965)
  app.use((req, res, next) => {
    const url = req.originalUrl || req.url;
    if (url.startsWith("/api") && !url.startsWith("/api/v1/") && url !== "/api/v1") {
      const target = url.replace(/^\/api(?=\/|\?|$)/, "/api/v1");
      return res.redirect(301, target);
    }
    next();
  });

  const v1Router = express.Router();

  // GET /api/v1/functions — distinct function names across all events
  v1Router.get(
    "/functions",
    asyncHandler(async (req, res) => {
      const now = Date.now();
      const cacheIsFresh =
        distinctFunctionsCache !== null && distinctFunctionsCache.expiresAt > now;

      if (cacheIsFresh) {
        res.setHeader("Cache-Control", "public, max-age=60");
        return res.json(distinctFunctionsCache.value);
      }

      const result = await db.getDistinctFunctions();
      distinctFunctionsCache = {
        value: result,
        expiresAt: now + 60_000,
      };
      res.setHeader("Cache-Control", "public, max-age=60");
      return res.json(result);
    })
  );

  // GET /api/v1/tokens/:id/metadata — SEP-41 token metadata from simulated calls
  v1Router.get(
    "/tokens/:id/metadata",
    asyncHandler(async (req, res) => {
      let metadata;
      try {
        metadata = await fetchTokenMetadata(req.params.id);
      } catch {
        return res.status(404).json({ error: "Contract is not SEP-41 compliant" });
      }

      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.json({ contract_id: req.params.id, ...metadata });
    })
  );

  // GET /api/v1/leaderboard?limit=10&cursor= — top contracts by event volume (issue #966)
  v1Router.get(
    "/leaderboard",
    asyncHandler(async (req, res) => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
      const cursor = req.query.cursor || null;
      const page = Number(req.query.page) || 1;
      const result = await db.getLeaderboard({ limit, cursor, page });
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json(result);
    })
  );

  // GET /api/v1/markets?limit=&cursor=&page= — prediction markets cursor pagination (issue #966)
  v1Router.get(
    "/markets",
    asyncHandler(async (req, res) => {
      const limit = Number(req.query.limit) || 20;
      const cursor = req.query.cursor || null;
      const page = Number(req.query.page) || 1;
      const result = await db.getMarkets({ limit, cursor, page });
      res.json(result);
    })
  );

  // GET /api/v1/bets?market_id=&limit=&cursor=&page= — bets cursor pagination (issue #966)
  v1Router.get(
    "/bets",
    asyncHandler(async (req, res) => {
      const limit = Number(req.query.limit) || 20;
      const cursor = req.query.cursor || null;
      const page = Number(req.query.page) || 1;
      const market_id = req.query.market_id || null;
      const result = await db.getBets({ market_id, limit, cursor, page });
      res.json(result);
    })
  );

  // GET /api/v1/events?contract=&fn=&page=&limit=&cursor=&q= — events cursor pagination (issue #966)
  v1Router.get(
    "/events",
    asyncHandler(async (req, res) => {
      const result = await db.getEvents({
        contract: req.query.contract,
        fn: req.query.fn,
        q: req.query.q,
        page: Number(req.query.page) || 1,
        limit: Number(req.query.limit) || 25,
        cursor: req.query.cursor || null,
      });
      res.json(result);
    })
  );

  // GET /api/v1/events/stream — Server-Sent Events endpoint for live event feed
  v1Router.get("/events/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const onEvent = (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    eventEmitter.on("event", onEvent);

    res.on("close", () => {
      eventEmitter.off("event", onEvent);
    });
  });

  // GET /api/v1/events/:seq/raw — raw un-decoded topics and data for a single event
  v1Router.get(
    "/events/:seq/raw",
    asyncHandler(async (req, res) => {
      const seqStr = String(req.params.seq).trim();
      const seq = parseInt(seqStr, 10);
      if (isNaN(seq) || seq < 0 || !/^\d+$/.test(seqStr)) {
        return res.status(400).json({ error: "seq must be a non-negative integer" });
      }
      const ev = await db.getEvent(seq);
      if (!ev) {
        return res.status(404).json({ error: "Not found" });
      }
      res.json({
        seq: ev.seq,
        raw_topics: ev.raw_topics,
        raw_data: ev.raw_data,
        tx_hash: ev.tx_hash,
      });
    })
  );

  // GET /api/v1/events/:seq — single event by sequence number
  v1Router.get(
    "/events/:seq",
    asyncHandler(async (req, res) => {
      const seqStr = String(req.params.seq).trim();
      const seq = parseInt(seqStr, 10);
      if (isNaN(seq) || seq < 0 || !/^\d+$/.test(seqStr)) {
        return res.status(400).json({ error: "seq must be a non-negative integer" });
      }
      const ev = await db.getEvent(seq);
      if (!ev) {
        return res.status(404).json({ error: "Not found" });
      }
      res.json(ev);
    })
  );

  // GET /api/v1/contracts?q=&page=&limit= — paginated list of registered contracts
  v1Router.get(
    "/contracts",
    asyncHandler(async (req, res) => {
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 25;
      const result = await db.getContracts({ q: req.query.q, page, limit });
      res.json(result);
    })
  );

  // GET /api/v1/contracts/:id/events?fn=&page= — paginated event history for contract
  v1Router.get(
    "/contracts/:id/events",
    asyncHandler(async (req, res) => {
      const meta = await db.getContractMeta(req.params.id);
      if (!meta) {
        return res.status(404).json({ error: "Not found" });
      }
      const result = await db.getEvents({
        contract: req.params.id,
        fn: req.query.fn,
        page: Number(req.query.page) || 1,
      });
      res.json(result);
    })
  );

  // GET /api/v1/contracts/:id
  v1Router.get(
    "/contracts/:id",
    asyncHandler(async (req, res) => {
      const meta = await db.getContractMeta(req.params.id);
      if (!meta) {
        return res.status(404).json({ error: "Not found" });
      }
      res.json(meta);
    })
  );

  // POST /api/v1/contracts — register contract ABI metadata
  v1Router.post(
    "/contracts",
    requireAdminKey,
    asyncHandler(async (req, res) => {
      const validationError = validateContractPayload(req.body);
      if (validationError) {
        return res.status(400).json({ error: validationError });
      }

      const existing = await db.getContractMeta(req.body.id);
      const registeredBy = req.body.registered_by ?? existing?.registered_by;

      if (existing?.registered_by && !registeredBy) {
        return res
          .status(400)
          .json({ error: "registered_by is required to update contract metadata" });
      }

      await db.upsertContractMeta({ ...req.body, registered_by: registeredBy });
      res.status(201).json({ ok: true });
    })
  );

  // GET /api/v1/wallet/:address — wallet events
  v1Router.get(
    "/wallet/:address",
    asyncHandler(async (req, res) => {
      const { address } = req.params;
      if (!isValidStellarAddress(address)) {
        return res.status(400).json({ error: "Invalid Stellar address" });
      }
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 25;
      const result = await db.getWalletEvents(address, { page, limit });
      res.json(result);
    })
  );

  // Mount unified v1 router under /api/v1
  app.use("/api/v1", v1Router);

  app.use(errorHandler);

  return app;
}

export function startApi() {
  return createApp().listen(PORT, () => {
    console.log(`[api] listening on ${PORT}`);
  });
}
