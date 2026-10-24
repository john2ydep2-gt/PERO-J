# Simulation and Verification Guide: Indexer & RPC Alerts

This guide documents how to simulate alert conditions and verify alerting behavior for `IndexerStalled` and `RPCHighErrorRate` alert rules.

## 1. Alert Specifications

| Alert Name | Metric Expression | Duration | Severity | Notification |
|---|---|---|---|---|
| `IndexerStalled` | `indexer_lag_ledgers > 100` | 3m | `critical` | PagerDuty + Slack |
| `RPCHighErrorRate` | `rate(rpc_errors_total[5m]) > 0.05` | 2m | `high` | Discord + Slack |

## 2. Simulating Indexer Stall (`IndexerStalled`)

### Trigger Condition
The indexer lag metric `indexer_lag_ledgers` represents `stellar_network_head_ledger - indexer_current_ledger`. If this exceeds 100 ledgers continuously for 3 minutes, the critical alert fires.

### Simulation Procedure

1. **Pause Indexer Ingestion (Docker / Local)**:
   ```bash
   # Temporarily pause indexer worker
   docker pause peroj-indexer-1
   ```
   Wait 3 minutes while the Stellar network advances past 100 ledgers (~5s per ledger in Stellar = 500 seconds, or simulate metric directly via Prometheus pushgateway/test endpoint).

2. **Simulate via Test Metric Injection**:
   ```bash
   # Push simulated lag metric to Prometheus Pushgateway or mock exporter
   curl -X POST -d "indexer_lag_ledgers 125\n" http://localhost:9091/metrics/job/indexer
   ```

3. **Verify Alert State in Prometheus**:
   - Query: `indexer_lag_ledgers > 100`
   - Navigate to `http://localhost:9090/alerts`
   - Verify `IndexerStalled` transitions from `PENDING` to `FIRING` after 3 minutes.
   - Inspect annotations: ensure `runbook_url` links to `docs/INDEXER_RUNBOOK.md` and `dashboard_url` links to the indexer dashboard.

4. **Remediation & Recovery**:
   ```bash
   docker unpause peroj-indexer-1
   ```
   Verify that once `indexer_lag_ledgers <= 100`, the alert automatically resolves.

---

## 3. Simulating RPC Failure Burst (`RPCHighErrorRate`)

### Trigger Condition
When `rate(rpc_errors_total[5m]) > 0.05` (more than 5% error rate or >0.05 errors/second depending on counter configuration) for 2 minutes, the high-severity alert fires.

### Simulation Procedure

1. **Simulate Failure Metric Injection**:
   ```bash
   # Inject burst of errors into test counter
   for i in {1..30}; do
     curl -s -X POST -d "rpc_errors_total 100\n" http://localhost:9091/metrics/job/rpc-adapter
     sleep 2
   done
   ```

2. **Verify Alert State in Prometheus**:
   - Query: `rate(rpc_errors_total[5m]) > 0.05`
   - Navigate to `http://localhost:9090/alerts`
   - Verify `RPCHighErrorRate` enters `FIRING` state after 2 minutes.
   - Inspect annotations: ensure `runbook_url` links to `docs/ORACLE_ADAPTER_FRESHNESS.md`.

3. **Resolution**:
   Halt error injection; once the 5-minute rolling rate falls below 0.05, Prometheus clears the alert and Alertmanager issues a resolve notification.
