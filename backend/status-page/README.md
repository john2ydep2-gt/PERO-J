# PERO-J Public Status Page

A lightweight, dependency-free (Node ≥ 20 built-ins only) service that publishes live platform health at **`/status`**.

## Components monitored

| Component | Probe | Degraded when | Major outage when |
|---|---|---|---|
| **Stellar Horizon / RPC Node** | `GET $HORIZON_URL` + JSON-RPC `getHealth` on `$RPC_URL` | latency > threshold, ledger stale, RPC not `healthy`, or only one endpoint down | both endpoints unreachable |
| **Chain Indexer & Event Processing** | `GET $INDEXER_URL/health` | `lag_seconds > LAG_ALERT_THRESHOLD_S` | lag > `STATUS_INDEXER_LAG_OUTAGE_S` or DB disconnected |
| **Optimistic Oracle Resolvers** | `GET $ORACLE_URL/health` | `status: degraded` or 0 active resolvers | non-2xx / unreachable |
| **Backend REST API** | `GET $API_URL/ready` | latency > threshold | non-2xx / unreachable |

Probes run automatically every `STATUS_PROBE_INTERVAL_MS` (default 30 s). Statuses, 24 h uptime, and latency history are calculated from the rolling probe history — no manual updates needed.

## Routes

| Route | Description |
|---|---|
| `GET /status` | Public HTML status page (auto-refreshes every 30 s) |
| `GET /status/api/summary` | Live component status JSON |
| `GET /status/api/incidents` | Active incidents + historical post-mortem log |
| `GET /healthz` | Liveness of the status service itself |

## Incident post-mortem log

Incidents are stored in [`incidents.json`](./incidents.json) (override with `STATUS_INCIDENTS_FILE`, e.g. a mounted ConfigMap). The file is re-read on every request, so publishing an update only requires editing the file. Each incident supports a timeline of `updates` and an optional `postMortem` (`summary`, `rootCause`, `resolution`, `actionItems`). Incidents without `resolvedAt` are shown as **active**.

## Configuration

| Variable | Default |
|---|---|
| `STATUS_PORT` | `3005` |
| `HORIZON_URL` | `https://horizon-testnet.stellar.org` |
| `RPC_URL` | `https://soroban-testnet.stellar.org` |
| `INDEXER_URL` | `http://localhost:3001` |
| `API_URL` | `$INDEXER_URL` |
| `ORACLE_URL` | _(unset → component shows "unknown")_ |
| `STATUS_PROBE_INTERVAL_MS` | `30000` |
| `STATUS_PROBE_TIMEOUT_MS` | `5000` |
| `STATUS_LATENCY_DEGRADED_MS` | `2000` |
| `LAG_ALERT_THRESHOLD_S` | `30` |
| `STATUS_INDEXER_LAG_OUTAGE_S` | `300` |
| `STATUS_RPC_LEDGER_STALE_S` | `60` |
| `STATUS_MAINTENANCE_MESSAGE` | _(unset)_ — shows a maintenance banner |

## Running

```bash
cd backend/status-page
npm start
# open http://localhost:3005/status
```

With Docker:

```bash
docker build -t pero-j-status-page backend/status-page
docker run -p 3005:3005 -e INDEXER_URL=http://host.docker.internal:3001 pero-j-status-page
```

Kubernetes: `kubectl apply -f k8s/status-page-deployment.yaml` and route `/status` on your ingress to the `status-page` service.
