# Synthetic Probe Monitoring (Frontend Uptime & Soroban RPC)

## 1. Overview & Objectives

While internal container metrics (CPU, memory, database query rate) provide visibility into the host environment, they cannot detect external connectivity issues such as:
- CDN cache poisoning or edge network routing degradation.
- DNS propagation failures.
- Soroban RPC gateway latency spikes impacting end users.

To guarantee end-to-end reliability, PERO-J runs **synthetic probes** from external vantage points targeting:
1. The **Frontend Web UI** (verifies HTTP 200 and loads essential bundles).
2. The **Indexer `/health` Endpoint** (verifies database connectivity and event synchronization).
3. The **Soroban RPC Provider** (submits `getHealth` JSON-RPC calls).

## 2. Service Level Agreement (SLA) & Alert Thresholds

- **Probe Frequency**: Every 30 seconds (`30s`).
- **Maximum Acceptable Response Time**: **2.5 seconds** (`2500ms`).
- **Availability Requirement**: HTTP 200 response with valid health payload.
- **Alert Trigger**: If response latency exceeds 2.5s or if any probe fails for > 30s, a critical alert is dispatched immediately to `#alerts-critical`.

## 3. Blackbox Exporter Configuration

Prometheus Blackbox exporter (`infra/monitoring/synthetic/blackbox.yml`) handles external HTTP probes:

- `http_2xx`: Probes frontend routes with a 2.5s timeout.
- `http_health_30s`: Validates `/health` HTTP 200 and `"status": "ok"` / `"status": "healthy"`.
- `soroban_rpc_probe`: Sends POST payload `{"jsonrpc":"2.0","id":1,"method":"getHealth"}` and expects HTTP 200 with healthy state within 2.5s.

## 4. Alerting Rules

Prometheus rules defined in `infra/monitoring/prometheus/synthetic-alerts.rules.yml`:

```yaml
- alert: FrontendHighLatency
  expr: probe_duration_seconds{job="frontend_synthetic"} > 2.5
  for: 30s
  labels:
    severity: critical
    channel: alerts-critical
  annotations:
    summary: "Frontend response time exceeds 2.5s SLA"
    description: "Synthetic probe response time for {{ $labels.instance }} is {{ $value }}s (> 2.5s SLA)."
```

## 5. Standalone Probe Runner

The probe runner script in `infra/monitoring/synthetic/probe-runner.ts` can be run in containerized probe clusters or via cron:

```bash
# Environment variables
FRONTEND_PROBE_URL=https://app.pero-j.io
HEALTH_PROBE_URL=https://indexer.pero-j.io/health
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org

# Start scheduler (pings every 30s, alerts on > 2.5s)
npx tsx infra/monitoring/synthetic/probe-runner.ts
```
