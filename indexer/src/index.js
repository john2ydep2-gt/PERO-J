import dotenv from "dotenv";
import { SorobanRpc } from "@stellar/stellar-sdk";
import { startApi } from "./api.js";
import { db } from "./db.js";
import { decode } from "./decoder.js";
import { reloadSacMap } from "./sac.js";
import { validateNetwork } from "./validateNetwork.js";

dotenv.config();

/** @typedef {import('./types.js').HealthState} HealthState */

const RPC_URL = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const START_LEDGER = Number(process.env.START_LEDGER || 0);
const POLL_MS = Number(process.env.POLL_MS || 5000);
const RPC_ERROR_THRESHOLD = 3;

let rpc = new SorobanRpc.Server(RPC_URL, { allowHttp: true });

/**
 * Shared health state exposed to the REST API via api.js.
 * Updated each time a ledger is successfully indexed.
 *
 * @type {HealthState}
 */
export const health = {
  /** Timestamp (ms) of the last successfully processed ledger, or null if none yet. */
  lastIndexedAt: null,
  /** Most-recently processed ledger sequence number. */
  lastLedger: null,
  /** Process start time for uptime calculation. */
  startedAt: Date.now(),
};

async function indexLedger(ledger) {
  // getEvents supports cursor-based pagination; we use ledger range here
  const res = await rpc.getEvents({
    startLedger: ledger,
    filters: [{ type: "contract" }],
    limit: 200,
  });

  for (const ev of res.events) {
    const decoded = await decode(ev);
    await db.upsertEvent(decoded);
    console.log(`[${ev.ledger}] ${decoded.function}: ${decoded.description}`);
  }

  // Record the time we finished processing this ledger batch
  health.lastIndexedAt = Date.now();
  health.lastLedger = res.latestLedger;

  return res.latestLedger;
}

let shuttingDown = false;

function gracefulShutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log("Shutdown signal received, finishing current iteration…");
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
process.on("SIGHUP", () => {
  console.log("SIGHUP received, reloading environment and SAC map...");
  dotenv.config({ override: true });
  reloadSacMap();
});

async function run() {
  await db.init();
  startApi();

  await validateNetwork(rpc);

  const persisted = await db.getCursor();
  let cursor = persisted ?? (START_LEDGER || (await rpc.getLatestLedger()).sequence - 100);
  if (persisted !== null) {
    console.log(`Resuming from persisted ledger ${cursor}`);
  }

  let consecutiveErrors = 0;

  while (!shuttingDown) {
    try {
      const latest = await indexLedger(cursor);
      cursor = latest + 1;
      await db.setCursor(latest);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      console.error("Indexer error:", err.message);
      if (consecutiveErrors >= RPC_ERROR_THRESHOLD) {
        console.warn(`${consecutiveErrors} consecutive RPC errors — recreating RPC client`);
        rpc = new SorobanRpc.Server(RPC_URL, { allowHttp: true });
        consecutiveErrors = 0;
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  await db.close();
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run();
}
