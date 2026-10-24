import dotenv from "dotenv";
import { SorobanRpc, StrKey } from "@stellar/stellar-sdk";
import { startApi } from "./api.js";
import { db } from "./db.js";
import { registerFixtures } from "./registerFixtures.js";
import { reloadSacMap } from "./sac.js";
import { validateNetwork } from "./validateNetwork.js";
import { resolvePollMs } from "./resolvePollMs.js";
import { handleOracleSubmission } from "./handlers/oracle_submission.js";
import { handleOracleDispute } from "./handlers/oracle_dispute.js";
import { handleOracleFinalized } from "./handlers/oracle_finalized.js";

dotenv.config();

/** @typedef {import('./types.js').HealthState} HealthState */

const RPC_URL = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const START_LEDGER = Number(process.env.START_LEDGER || 0);
const POLL_MS = resolvePollMs();
const RPC_ERROR_THRESHOLD = 3;

/**
 * Advisory lock id for the single active writer. Only the instance holding
 * it polls the RPC and writes; others stand by and take over on release.
 */
const INDEXER_LOCK_ID = 837;
const WRITER_STANDBY_POLL_MS = 5000;
const WRITER_HEARTBEAT_MS = 5000;

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

/**
 * Recursively walk decoded topic/data values and collect every Stellar
 * public key (strkey `G…`, 56 chars) found in the structure.
 *
 * Handles nested arrays and plain objects so addresses embedded in
 * structs, vectors, and maps are all discovered.
 *
 * @param {*} values - Decoded value(s) to scan.
 * @param {Set<string>} [found] - Accumulator for deduplication.
 * @returns {string[]} Deduplicated list of Stellar public keys.
 */
export function extractAddresses(values, found = new Set()) {
  if (values === null || values === undefined) {
    return [...found];
  }

  if (typeof values === "string") {
    if (values.length === 56 && values.startsWith("G")) {
      try {
        if (StrKey.isValidEd25519PublicKey(values)) {
          found.add(values);
        }
      } catch {
        // Not a valid strkey — ignore.
      }
    }
    return [...found];
  }

  if (Array.isArray(values)) {
    for (const item of values) {
      extractAddresses(item, found);
    }
    return [...found];
  }

  if (typeof values === "object") {
    for (const value of Object.values(values)) {
      extractAddresses(value, found);
    }
  }

  return [...found];
}

export async function indexLedger(ledger, rpcClient = rpc) {
  const latestLedger = await rpcClient.getLatestLedger();
  const events = [];
  let cursor;
  while (true) {
    const res = await rpcClient.getEvents({
      startLedger: ledger,
      cursor,
      filters: [{ type: "contract" }],
      limit: 200,
    });
    if (res.latestLedger !== latestLedger.sequence) {
      throw new Error(
        `RPC ledger changed during event fetch (${res.latestLedger} -> ${latestLedger.sequence}); retrying`
      );
    }
    events.push(...res.events);
    if (res.events.length < 200) {
      break;
    }
    const nextCursor = res.events.at(-1)?.pagingToken;
    if (!nextCursor || nextCursor === cursor) {
      throw new Error("RPC event pagination did not advance; retrying");
    }
    cursor = nextCursor;
  }

  const decodedEvents = [];
  for (const ev of events) {
    // On-chain `update` events from the explorer contract let us invalidate
    // the in-memory ABI cache immediately, instead of waiting for the 60s LRU
    // TTL to expire, so an ABI update is reflected near-instantly.
    if (isExplorerUpdateEvent(ev)) {
      const targetContractId = updateEventContractId(ev);
      if (targetContractId) {
        evictContractMeta(targetContractId);
      }
    }

    const nextCursor = res.cursor;
    if (
      reachedEndLedger ||
      res.events.length === 0 ||
      !nextCursor ||
      nextCursor === paginationCursor
    ) {
      break;
    }
    await db.upsertEvent(decoded);
    // Fire-and-forget after commit: Redis failures never block indexing.
    void publish(`stellar:events:${decoded.function}`, {
      type: decoded.function,
      market_id: decoded.contract_id,
      timestamp: new Date().toISOString(),
      state: { ledger: decoded.ledger, tx_hash: decoded.tx_hash, description: decoded.description },
    });
    console.log(`[${ev.ledger}] ${decoded.function}: ${decoded.description}`);

    // Route oracle events to their handlers
    const topics = ev.topic.map((t) => {
      try {
        return typeof t.sym === "function" ? t.sym() : t.value?.()?.sym?.() ?? String(t);
      } catch {
        return String(t);
      }
    });
    
    const data = ev.value;

    if (decoded.function === "oracle_submission") {
      await handleOracleSubmission(decoded, topics, data);
    } else if (decoded.function === "oracle_dispute") {
      await handleOracleDispute(decoded, topics, data);
    } else if (decoded.function === "oracle_finalized") {
      await handleOracleFinalized(decoded, topics, data);
    }
  }

  // Record the time we finished processing this ledger batch
  health.lastIndexedAt = Date.now();
  health.lastLedger = latestLedger.sequence;

  return latestLedger.sequence;
}

/**
 * Route an unparseable event to the dead-letter table with the failure reason.
 * Never throws, so a bad event cannot crash the ingestion loop.
 *
 * @param {object} ev - Raw event object
 * @param {string} reason
 */
async function sendToDeadLetter(ev, reason) {
  console.warn(`[dlq] ledger=${ev?.ledger} tx=${ev?.txHash}: ${reason}`);
  try {
    let raw;
    try {
      raw = JSON.stringify(ev, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    } catch {
      raw = String(ev);
    }
    await db.insertDeadLetter({
      contract_id: typeof ev?.contractId === "string" ? ev.contractId : undefined,
      ledger: ev?.ledger,
      tx_hash: typeof ev?.txHash === "string" ? ev.txHash : undefined,
      reason,
      raw_event: raw,
    });
  } catch (err) {
    console.error("[dlq] failed to persist dead-letter event:", err.message);
  }
}

/**
 * Return true when an event is the explorer contract's `update` event, which
 * signals that a registered contract's ABI metadata changed on-chain.
 *
 * The first topic is the `update` symbol; the second is the target contract's
 * raw 32-byte id held in `BytesN<32>`.
 *
 * @param {object} ev - Raw event object from SorobanRpc.getEvents()
 * @returns {boolean}
 */
export function isExplorerUpdateEvent(ev) {
  if (!EXPLORER_CONTRACT_ID || ev.contractId !== EXPLORER_CONTRACT_ID) {
    return false;
  }
  const topic = ev.topic?.[0];
  if (!topic) {
    return false;
  }
  try {
    const symbol =
      typeof topic.sym === "function" ? topic.sym() : topic.value?.()?.sym();
    return symbol === "update";
  } catch {
    return false;
  }
}

  return onlyLedger ?? latestLedger;
}

let shuttingDown = false;
let stopCouncilInactivityMonitor;

function gracefulShutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  stopCouncilInactivityMonitor?.();
  console.log("Shutdown signal received, finishing current iteration…");
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
process.on("SIGHUP", () => {
  console.log("SIGHUP received, reloading environment and SAC map...");
  dotenv.config({ override: true });
  reloadSacMap();
});

/**
 * Run migrations before starting the API/poller.
 *
 * `db.init()` acquires its own Postgres advisory lock internally (see db.js),
 * so two indexer instances starting concurrently cannot run migrations at the
 * same time. There is no need for an additional outer lock here.
 */
async function runMigrations() {
  await db.init();
}

async function run() {
  await runMigrations();
  await registerFixtures().catch((err) => {
    console.error("[fixtures] failed to register ABI fixtures:", err.message);
  });

  startApi();

  const stopDlqWorker = startDlqRetryWorker(db, (payload) => db.upsertEvent(payload));
  const stopDriftDetector = startDriftDetector(db);

  await validateNetwork(rpc);

  const councilMonitorConfig = getCouncilInactivityConfig();
  if (councilMonitorConfig) {
    stopCouncilInactivityMonitor = startCouncilInactivityMonitor({
      fetchActive: oracleDisputes.fetchActive,
      config: councilMonitorConfig,
    });
    console.log("[oracle monitor] council inactivity monitoring enabled");
  } else {
    console.warn(
      "[oracle monitor] disabled: configure ORACLE_CONTRACT_ID, PAGERDUTY_ROUTING_KEY, and ORACLE_COUNCIL_ROSTER",
    );
  }

  const persisted = await db.getCursor();
  let cursor = persisted ?? (START_LEDGER || (await rpc.getLatestLedger()).sequence - 100);
  if (persisted !== null) {
    console.log(`Resuming after persisted ledger ${persisted}`);
  }

  let consecutiveErrors = 0;

  while (!shuttingDown) {
    try {
      const latest = await indexLedger(cursor);
      cursor = latest + 1;
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

  stopDlqWorker();
  stopDriftDetector();
  await db.close();
  process.exit(lockLost ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run();
}
