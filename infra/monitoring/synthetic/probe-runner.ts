/**
 * infra/monitoring/synthetic/probe-runner.ts
 *
 * Synthetic probe monitoring runner for frontend uptime, backend /health,
 * and external Soroban RPC health.
 *
 * Checks:
 * 1. Frontend end-to-end availability & response latency (< 2.5s SLA).
 * 2. Backend indexer /health HTTP 200 ping every 30 seconds.
 * 3. Soroban RPC JSON-RPC health check latency (< 2.5s).
 *
 * Emits alerts to #alerts-critical via notifier bot when SLA threshold (> 2.5s) is breached.
 */

import { notifier } from "../../backend/shared/notifier.js";

export interface ProbeTarget {
  name: string;
  url: string;
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  expectedStatus?: number;
  slaTimeoutMs?: number; // default: 2500ms (2.5 seconds)
}

export interface ProbeResult {
  target: string;
  url: string;
  durationMs: number;
  status: number;
  success: boolean;
  slaBreached: boolean;
  error?: string;
}

export const DEFAULT_TARGETS: ProbeTarget[] = [
  {
    name: "Frontend Uptime Probe",
    url: process.env.FRONTEND_PROBE_URL || "http://localhost:3000",
    method: "GET",
    expectedStatus: 200,
    slaTimeoutMs: 2500,
  },
  {
    name: "Indexer Health Ping",
    url: process.env.HEALTH_PROBE_URL || "http://localhost:3001/health",
    method: "GET",
    expectedStatus: 200,
    slaTimeoutMs: 2500,
  },
  {
    name: "Soroban RPC Probe",
    url: process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
    expectedStatus: 200,
    slaTimeoutMs: 2500,
  },
];

/**
 * Executes a single synthetic HTTP probe with high-resolution duration measurement.
 */
export async function runSingleProbe(target: ProbeTarget): Promise<ProbeResult> {
  const start = performance.now();
  const slaLimit = target.slaTimeoutMs || 2500;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), slaLimit + 2000);

  try {
    const res = await fetch(target.url, {
      method: target.method || "GET",
      headers: target.headers,
      body: target.body,
      signal: controller.signal,
    });

    const durationMs = Math.round(performance.now() - start);
    clearTimeout(timeoutId);

    const isStatusOk = res.status === (target.expectedStatus || 200);
    const slaBreached = durationMs > slaLimit;

    return {
      target: target.name,
      url: target.url,
      durationMs,
      status: res.status,
      success: isStatusOk && !slaBreached,
      slaBreached,
    };
  } catch (err: any) {
    const durationMs = Math.round(performance.now() - start);
    clearTimeout(timeoutId);

    return {
      target: target.name,
      url: target.url,
      durationMs,
      status: 0,
      success: false,
      slaBreached: durationMs > slaLimit,
      error: err.name === "AbortError" ? "Probe request timed out" : err.message,
    };
  }
}

/**
 * Executes all configured synthetic probes and triggers alerts for failures or SLA breaches.
 */
export async function runSyntheticProbes(
  targets: ProbeTarget[] = DEFAULT_TARGETS
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];

  for (const target of targets) {
    const result = await runSingleProbe(target);
    results.push(result);

    if (!result.success) {
      const issue = result.slaBreached
        ? `Response time ${result.durationMs}ms exceeded 2.5s SLA limit`
        : `Probe failed with status ${result.status}: ${result.error || "Bad response"}`;

      console.warn(`[SyntheticProbeAlert] ${target.name} failure: ${issue}`);

      await notifier.sendCriticalAlert(
        `Synthetic Probe Alert: ${target.name}`,
        issue,
        [
          { name: "Target URL", value: target.url, inline: true },
          { name: "Latency", value: `${result.durationMs}ms (Limit: 2500ms)`, inline: true },
          { name: "Status Code", value: String(result.status), inline: true },
        ],
        target.url
      );
    }
  }

  return results;
}

/**
 * Starts continuous probing every 30 seconds.
 */
export function startProbeScheduler(intervalMs = 30_000) {
  console.log(`[SyntheticProbe] Starting probe scheduler (interval: ${intervalMs}ms)`);
  runSyntheticProbes();
  return setInterval(runSyntheticProbes, intervalMs);
}
