import http from "node:http";
import pg from "pg";
import { submitExpiredMarket } from "./workers/auto-submitter.js";

const POLL_MS = Number(process.env.ORACLE_POLL_MS) || 15_000;
const HEARTBEAT_MS = Number(process.env.ORACLE_HEARTBEAT_MS) || 60_000;
const HEALTH_PORT = Number(process.env.ORACLE_HEALTH_PORT) || 9101;

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

export const metrics = {
  startedAt: Date.now(),
  lastPollAt: null,
  polls: 0,
  pollErrors: 0,
  marketsSubmitted: 0,
};

/** Scan for expired open markets and submit each one. */
export async function pollOnce(db = pool, submit = submitExpiredMarket) {
  const { rows } = await db.query(
    "SELECT id, category, params FROM markets WHERE ends_at <= NOW() AND status = 'open' ORDER BY ends_at",
  );
  for (const market of rows) {
    if (await submit(db, market)) {
      metrics.marketsSubmitted++;
    }
  }
  metrics.polls++;
  metrics.lastPollAt = Date.now();
}

async function run() {
  let stopping = false;
  let timer;

  const loop = async () => {
    try {
      await pollOnce();
    } catch (err) {
      metrics.pollErrors++;
      console.error("[oracle] poll failed:", err.message);
    }
    if (!stopping) {
      timer = setTimeout(loop, POLL_MS);
    }
  };

  const heartbeat = setInterval(
    () =>
      console.log(
        JSON.stringify({ event: "heartbeat", ...metrics, ts: Date.now() }),
      ),
    HEARTBEAT_MS,
  );

  const server = http
    .createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/health") {
        res.end(JSON.stringify({ status: "ok", ...metrics }));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    })
    .listen(HEALTH_PORT);

  const shutdown = async (signal) => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(`[oracle] ${signal} received, shutting down`);
    clearTimeout(timer);
    clearInterval(heartbeat);
    server.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await loop();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run();
}
