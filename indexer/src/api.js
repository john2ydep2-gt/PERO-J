import express from "express";
import rateLimit from "express-rate-limit";
import { LRUCache } from "lru-cache";
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

export function startApi() {
  const app = express();
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
          latestLedger: health.lastLedger,
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
        latestLedger: health.lastLedger,
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
      res.status(200).json({ status: "ok", db: "connected", latestLedger: health.lastLedger });
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

  // GET /api/functions — distinct function names across all events
  app.get(
    "/api/functions",
    asyncHandler(async (req, res) => {
      const result = await db.getDistinctFunctions();
      res.json(result);
    })
  );

  // GET /api/leaderboard?limit=10 — top contracts by event volume
  app.get(
    "/api/leaderboard",
    asyncHandler(async (req, res) => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
      const result = await db.getLeaderboard(limit);
      res.setHeader("Cache-Control", "public, max-age=60");
      res.json(result);
    })
  );

  // GET /api/events?contract=&fn=&page=&q=
  app.get(
    "/api/events",
    asyncHandler(async (req, res) => {
      const result = await db.getEvents({
        contract: req.query.contract,
        fn: req.query.fn,
        q: req.query.q,
        page: Number(req.query.page) || 1,
      });
      res.json(result);
    })
  );

  // GET /api/events/stream — Server-Sent Events endpoint for live event feed
  app.get("/api/events/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const onEvent = (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    eventEmitter.on("event", onEvent);

    req.on("close", () => {
      eventEmitter.off("event", onEvent);
      res.end();
    });
  });

  // GET /api/events/:seq
  app.get(
    "/api/events/:seq",
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

  // GET /api/contracts?q=&page=&limit= — paginated list of registered contracts,
  // optionally filtered by name/description via case-insensitive search.
  app.get(
    "/api/contracts",
    asyncHandler(async (req, res) => {
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 25;
      const result = await db.getContracts({ q: req.query.q, page, limit });
      res.json(result);
    })
  );

  // GET /api/contracts/:id
  app.get(
    "/api/contracts/:id",
    asyncHandler(async (req, res) => {
      const meta = await db.getContractMeta(req.params.id);
      if (!meta) {
        return res.status(404).json({ error: "Not found" });
      }
      res.json(meta);
    })
  );

  // POST /api/contracts — register ABI metadata
  app.post(
    "/api/contracts",
    asyncHandler(async (req, res) => {
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

  // DELETE /api/contracts/:id — remove contract ABI metadata (admin-authenticated)
  app.delete(
    "/api/contracts/:id",
    requireAdminKey,
    asyncHandler(async (req, res) => {
      const existing = await db.getContractMeta(req.params.id);
      if (!existing) {
        return res.status(404).json({ error: "Not found" });
      }
      await db.deleteContractMeta(req.params.id);
      res.status(204).send();
    })
  );

  // GET /api/wallet/:address
  app.get(
    "/api/wallet/:address",
    asyncHandler(async (req, res) => {
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 25;
      const result = await db.getWalletEvents(req.params.address, { page, limit });
      res.json(result);
    })
  );

  // GET /api/tokens/:id/volume — 24-hour rolling transfer volume
  // Query params:
  //   decimals (optional, integer) — override the token decimal precision instead of
  //   fetching it from on-chain metadata / simulation.  Useful when the simulation call
  //   would add latency or the caller already knows the precision.
  app.get(
    "/api/tokens/:id/volume",
    asyncHandler(async (req, res) => {
      const contractId = req.params.id;

      // Allow caller to bypass the metadata lookup with an explicit decimals override.
      let decimals;
      if (req.query.decimals !== undefined) {
        const parsed = parseInt(req.query.decimals, 10);
        if (isNaN(parsed) || parsed < 0 || parsed > 38) {
          return res.status(400).json({ error: "decimals must be an integer between 0 and 38" });
        }
        decimals = parsed;
      } else {
        // Fetch decimals from on-chain metadata (cached via contract registry or live sim)
        decimals = 7;
        try {
          const meta = await fetchTokenMetadata(contractId);
          decimals = meta.decimals;
        } catch {
          /* use default */
        }
      }

      const volume = await db.get24hVolume(contractId, decimals);
      res.json({ contract_id: contractId, window: "24h", ...volume });
    })
  );

  app.use((req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use(errorHandler);

  return app;
}

export function startApi(port = PORT) {
  const app = createApp();
  return app.listen(port, () => console.log(`API listening on :${port}`));
}

