import { runAllProbes, worstStatus, STATUS } from "./probes.js";

/**
 * In-memory store of the latest probe results plus a rolling history used to
 * compute uptime percentages and latency sparklines.
 */
export class StatusMonitor {
  constructor(cfg, { fetchImpl = fetch, logger = console } = {}) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    /** @type {Map<string, import("./probes.js").ProbeResult>} */
    this.latest = new Map();
    /** @type {Map<string, Array<{ t: number, status: string, latencyMs: number|null }>>} */
    this.history = new Map();
    this.timer = null;
    this.lastRunAt = null;
    this.running = false;
  }

  async tick() {
    if (this.running) return; // never overlap probe rounds
    this.running = true;
    try {
      const results = await runAllProbes(this.cfg, this.fetchImpl);
      const t = Date.now();
      for (const r of results) {
        const prev = this.latest.get(r.id);
        if (prev && prev.status !== r.status) {
          this.logger.info?.(`[status] ${r.name}: ${prev.status} -> ${r.status} (${r.message})`);
        }
        this.latest.set(r.id, r);
        const h = this.history.get(r.id) ?? [];
        h.push({ t, status: r.status, latencyMs: r.latencyMs });
        if (h.length > this.cfg.historySize) h.splice(0, h.length - this.cfg.historySize);
        this.history.set(r.id, h);
      }
      this.lastRunAt = new Date(t).toISOString();
    } catch (err) {
      this.logger.error?.("[status] probe round failed", err);
    } finally {
      this.running = false;
    }
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.cfg.probeIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  uptime(id) {
    const h = this.history.get(id) ?? [];
    const known = h.filter((s) => s.status !== STATUS.UNKNOWN);
    if (!known.length) return null;
    const up = known.filter((s) => s.status === STATUS.OPERATIONAL || s.status === STATUS.DEGRADED).length;
    return Math.round((up / known.length) * 10_000) / 100;
  }

  snapshot() {
    const components = [...this.latest.values()].map((c) => {
      const h = this.history.get(c.id) ?? [];
      return {
        ...c,
        uptimePercent: this.uptime(c.id),
        latencyHistory: h.slice(-60).map((s) => ({ t: new Date(s.t).toISOString(), latencyMs: s.latencyMs, status: s.status })),
      };
    });
    const overall = components.length ? worstStatus(components.map((c) => c.status)) : STATUS.UNKNOWN;
    return {
      overall,
      summary: summaryFor(overall),
      maintenance: this.cfg.maintenanceMessage || null,
      lastCheckedAt: this.lastRunAt,
      probeIntervalSeconds: Math.round(this.cfg.probeIntervalMs / 1000),
      components,
    };
  }
}

export function summaryFor(status) {
  switch (status) {
    case STATUS.OPERATIONAL:
      return "All systems operational";
    case STATUS.DEGRADED:
      return "Some systems are experiencing degraded performance";
    case STATUS.MAJOR_OUTAGE:
      return "Major outage in progress";
    default:
      return "Status checks are initialising";
  }
}
