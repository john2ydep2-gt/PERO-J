/**
 * Runtime configuration for the public status page.
 *
 * Every value can be overridden through environment variables so the same
 * image can be deployed against testnet, staging, or mainnet.
 */

function num(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function loadConfig(env = process.env) {
  return {
    port: num(env.STATUS_PORT ?? env.PORT, 3005),
    /** How often the automated health probes run (ms). */
    probeIntervalMs: num(env.STATUS_PROBE_INTERVAL_MS, 30_000),
    /** Per-probe request timeout (ms). */
    probeTimeoutMs: num(env.STATUS_PROBE_TIMEOUT_MS, 5_000),
    /** Number of probe samples kept per component for uptime / latency history. */
    historySize: num(env.STATUS_HISTORY_SIZE, 2_880), // 24h at 30s interval

    horizonUrl: env.HORIZON_URL || "https://horizon-testnet.stellar.org",
    rpcUrl: env.RPC_URL || "https://soroban-testnet.stellar.org",
    indexerUrl: env.INDEXER_URL || "http://localhost:3001",
    apiUrl: env.API_URL || env.INDEXER_URL || "http://localhost:3001",
    /** Optional oracle resolver health endpoint. When unset the component reports "unknown". */
    oracleUrl: env.ORACLE_URL || "",

    thresholds: {
      /** Latency above which a component is considered degraded (ms). */
      latencyDegradedMs: num(env.STATUS_LATENCY_DEGRADED_MS, 2_000),
      /** Indexer lag above which the indexer is degraded (s). */
      indexerLagDegradedS: num(env.LAG_ALERT_THRESHOLD_S, 30),
      /** Indexer lag above which the indexer is considered a major outage (s). */
      indexerLagOutageS: num(env.STATUS_INDEXER_LAG_OUTAGE_S, 300),
      /** RPC ledger staleness above which RPC is degraded (s). */
      rpcLedgerStaleS: num(env.STATUS_RPC_LEDGER_STALE_S, 60),
    },

    /** Path to the incident post-mortem log (JSON). */
    incidentsFile: env.STATUS_INCIDENTS_FILE || new URL("../incidents.json", import.meta.url).pathname,
    /** Optional maintenance banner shown on the page. */
    maintenanceMessage: env.STATUS_MAINTENANCE_MESSAGE || "",
  };
}
