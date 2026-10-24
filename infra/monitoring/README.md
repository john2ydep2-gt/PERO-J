# PERO-J Monitoring — Grafana Dashboards

Three dashboards are defined as code in [`dashboards/`](./dashboards) and are **imported automatically** by Grafana's file provisioning — no manual import required.

| File | UID | Purpose |
|---|---|---|
| [`pipeline-health.json`](./dashboards/pipeline-health.json) | `peroj-pipeline-health` | Indexer lag, RPC latency, DB connection pool, HTTP error rates |
| [`oracle-states.json`](./dashboards/oracle-states.json) | `peroj-oracle-states` | Active disputes, bond exposure, submission volume, council vote tallies |
| [`business-kpis.json`](./dashboards/business-kpis.json) | `peroj-business-kpis` | 24h betting volume, active bettors, fee generation, IPREDICT mints |

All dashboards share `$datasource` and `$env` template variables, cross-link to each other, auto-refresh (30 s / 1 m), and overlay a **Deployments** annotation driven by `peroj_build_info`.

## Layout

```
infra/monitoring/
├── dashboards/                         # Dashboard JSON (source of truth)
├── grafana/provisioning/
│   ├── dashboards/pero-j.yml           # File provider → folder "PERO-J"
│   └── datasources/prometheus.yml      # Prometheus datasource (uid: prometheus)
├── prometheus/prometheus.yml           # Scrape config
└── docker-compose.monitoring.yml       # Prometheus + Grafana + postgres-exporter
```

## Running locally

```bash
docker compose -f docker-compose.yml -f infra/monitoring/docker-compose.monitoring.yml up -d
open http://localhost:3300   # admin / admin (override with GRAFANA_ADMIN_PASSWORD)
```

Grafana starts with the three dashboards in the **PERO-J** folder. The provider re-scans every 30 s, so editing a JSON file is reflected live. `allowUiUpdates: false` keeps Git as the single source of truth — export changes from the UI and commit them.

## Kubernetes

Create a ConfigMap from the dashboards and mount it at `/var/lib/grafana/dashboards/pero-j` together with the provisioning files:

```bash
kubectl create configmap pero-j-grafana-dashboards --from-file=infra/monitoring/dashboards/ \
  --dry-run=client -o yaml | kubectl label --local -f - grafana_dashboard=1 -o yaml | kubectl apply -f -
```

If you use the kube-prometheus-stack Grafana sidecar, the `grafana_dashboard=1` label is enough for automatic import.

## Metric catalog

The dashboards expect the following Prometheus metrics. Services expose them on `/metrics`; every series should carry an `env` label.

### Pipeline health

| Metric | Type | Labels |
|---|---|---|
| `peroj_indexer_lag_seconds` | gauge | `instance` |
| `peroj_indexer_last_ledger` | gauge | |
| `peroj_rpc_latest_ledger` | gauge | |
| `peroj_indexer_events_processed_total` | counter | `contract_type` |
| `peroj_indexer_errors_total` | counter | `reason` |
| `peroj_rpc_request_duration_seconds` | histogram | `method` |
| `peroj_rpc_requests_total` | counter | `method`, `status` |
| `peroj_db_pool_connections` | gauge | `state` = `active` \| `idle` \| `waiting` |
| `peroj_db_pool_max` | gauge | |
| `peroj_db_query_duration_seconds` | histogram | `operation` |
| `http_requests_total` | counter | `route`, `status_code` |
| `http_request_duration_seconds` | histogram | `route` |

### Oracle states

| Metric | Type | Labels |
|---|---|---|
| `peroj_oracle_active_disputes` | gauge | |
| `peroj_oracle_pending_proposals` | gauge | |
| `peroj_oracle_bond_exposure_xlm` | gauge | `role` = `proposer` \| `challenger` |
| `peroj_oracle_submissions_total` | counter | `outcome` |
| `peroj_oracle_disputes_resolved_total` | counter | `result` |
| `peroj_oracle_bonds_slashed_xlm_total` | counter | |
| `peroj_oracle_bonds_rewarded_xlm_total` | counter | |
| `peroj_oracle_time_to_finalize_seconds` | histogram | |
| `peroj_council_votes` | gauge | `market_id`, `vote` (current tally on open disputes) |
| `peroj_council_quorum` | gauge | `market_id` |
| `peroj_council_votes_total` | counter | `vote` |

### Business KPIs

| Metric | Type | Labels |
|---|---|---|
| `peroj_bet_volume_xlm_total` | counter | `outcome`, `market_id`, `question` |
| `peroj_bets_total` | counter | |
| `peroj_active_bettors` | gauge | `window` = `1h` \| `24h` |
| `peroj_fees_collected_xlm_total` | counter | `source` |
| `peroj_ipredict_minted_total` | counter | `reason` |
| `peroj_markets` | gauge | `state` |
| `peroj_payouts_claimed_xlm_total` | counter | |
| `peroj_build_info` | gauge | `version` (deploy annotations) |

## Validating changes

Dashboards target Grafana ≥ 10 (`schemaVersion: 39`). Before committing, confirm the JSON parses:

```bash
for f in infra/monitoring/dashboards/*.json; do node -e "JSON.parse(require('fs').readFileSync('$f'))" && echo "ok $f"; done
```
