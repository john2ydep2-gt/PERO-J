# Simulation and Verification Guide: Stuck Markets & Council Alerts

This guide documents the alert definitions, SLA thresholds, simulated failure testing, and notification routing for market lifecycle and governance alerts.

## 1. Alert Definitions and SLA Thresholds

| Alert Name | Metric Condition | SLA Threshold | Severity | Target Team |
|---|---|---|---|---|
| `MarketStuckInUnresolved` / `MarketStuck` | `count(markets{status="open", ends_at_elapsed_hours > 48}) > 0` | 48 hours post-expiry | `critical` | `operations` |
| `CouncilVoteStalled` | `count(disputes{status="escalated", elapsed_hours > 24, votes_cast < 4}) > 0` | 24 hours with < 4 votes | `high` | `operations` |

## 2. Notification Dispatch

Alerts tagged with `team: operations` route directly to:
1. **Slack `#ops-alerts`**: Formatted card listing affected market/dispute IDs, status, and direct runbook links.
2. **PagerDuty Escalation**: On-call operations engineer paged immediately for critical severity (`MarketStuckInUnresolved`).

## 3. Simulated Verification Procedure

### A. Simulating Stuck Market Alert (`MarketStuckInUnresolved` / `MarketStuck`)

1. **Inject Metric Data**:
   ```bash
   curl -X POST -d "markets{status=\"open\", ends_at_elapsed_hours=\"52\", market_id=\"MKT-802\"} 1\n" \
     http://localhost:9091/metrics/job/oracle-daemon
   ```

2. **Evaluate in Prometheus**:
   - Query: `count(markets{status="open", ends_at_elapsed_hours > 48}) > 0`
   - Confirm status enters `FIRING` after 5 minutes.
   - Verify annotations provide:
     - Direct runbook link: `docs/ORACLE_RUNBOOK.md`
     - Market lifecycle dashboard: `https://grafana.peroj.network/d/market-lifecycle`

3. **Verify Alertmanager Notification**:
   - Verify notification dispatched to `#ops-alerts` containing `MKT-802`.

### B. Simulating Council Inactivity Alert (`CouncilVoteStalled`)

1. **Inject Metric Data**:
   ```bash
   curl -X POST -d "disputes{status=\"escalated\", elapsed_hours=\"28\", votes_cast=\"2\", dispute_id=\"DISP-104\"} 1\n" \
     http://localhost:9091/metrics/job/oracle-daemon
   ```

2. **Evaluate in Prometheus**:
   - Query: `count(disputes{status="escalated", elapsed_hours > 24, votes_cast < 4}) > 0`
   - Confirm rule fires after 5 minutes.
   - Verify annotations link to `docs/COUNCIL_RUNBOOK.md`.

3. **Resolution**:
   Update votes or finalize outcome, dropping stalled metric count to 0. Prometheus clears alert automatically.
