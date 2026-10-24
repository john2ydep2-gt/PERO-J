# Operational Runbook Index

This document provides a centralized registry mapping operational Prometheus alerts to their corresponding remediation runbooks, verification commands, and automated remediation CLI scripts.

---

## 1. Alert to Runbook Mapping Matrix

| Prometheus Alert Name | Target Service | Severity | Markdown Runbook | Verification Command | Remediation Script |
|---|---|---|---|---|---|
| **`IndexerStalled`** | `indexer` | `Critical` | [INDEXER_RUNBOOK.md](INDEXER_RUNBOOK.md) | `curl -s http://localhost:3001/api/health` | [`scripts/remediation/restart_indexer.sh`](../scripts/remediation/restart_indexer.sh) |
| **`MarketStuck`** / `MarketStuckInUnresolved` | `oracle` | `Critical` | [ORACLE_RUNBOOK.md](ORACLE_RUNBOOK.md) | `curl -s http://localhost:3001/api/markets?status=open&expired=true` | [`scripts/remediation/resolve_stuck_market.sh`](../scripts/remediation/resolve_stuck_market.sh) |
| **`LeaderboardDrift`** | `indexer` / `db` | `High` | [LEADERBOARD_REBUILD_RUNBOOK.md](LEADERBOARD_REBUILD_RUNBOOK.md) | `curl -s http://localhost:3001/api/leaderboard/status` | [`scripts/remediation/rebuild_leaderboard.sh`](../scripts/remediation/rebuild_leaderboard.sh) |
| **`RPCHighErrorRate`** | `rpc-adapter` | `High` | [ORACLE_ADAPTER_FRESHNESS.md](ORACLE_ADAPTER_FRESHNESS.md) | `curl -s -X POST $RPC_URL -d '{"method":"getHealth"}'` | [`scripts/remediation/switch_rpc_provider.sh`](../scripts/remediation/switch_rpc_provider.sh) |
| **`CouncilVoteStalled`** | `governance` | `High` | [COUNCIL_RUNBOOK.md](COUNCIL_RUNBOOK.md) | `curl -s http://localhost:3001/api/disputes?status=escalated` | N/A (Governance Quorum Notification) |

---

## 2. On-Call Incident Triage Workflow

```text
[Prometheus Alert Fired]
           │
           ▼
[Alertmanager Dispatches PagerDuty / Slack]
           │
           ▼
[On-Call Engineer Consults docs/RUNBOOK_INDEX.md]
           │
           ├─► IndexerStalled    ──► Check lag & logs ──► Run restart_indexer.sh
           ├─► MarketStuck       ──► Inspect oracle   ──► Run resolve_stuck_market.sh
           ├─► LeaderboardDrift  ──► Check drift SQL  ──► Run rebuild_leaderboard.sh
           └─► RPCHighErrorRate  ──► Test RPC latency ──► Run switch_rpc_provider.sh
           │
           ▼
[Verify Alert Resolves & Post Incident Status Update]
```

---

## 3. Alert Deep-Dives & Remediation Summary

### IndexerStalled
- **Trigger**: `indexer_lag_ledgers > 100` for 3 minutes.
- **Runbook**: [INDEXER_RUNBOOK.md](INDEXER_RUNBOOK.md)
- **Remediation**:
  ```bash
  # Check status and restart indexer
  ./scripts/remediation/restart_indexer.sh
  ```

### MarketStuck
- **Trigger**: `count(markets{status="open", ends_at_elapsed_hours > 48}) > 0` for 5 minutes.
- **Runbook**: [ORACLE_RUNBOOK.md](ORACLE_RUNBOOK.md)
- **Remediation**:
  ```bash
  # Force re-poll oracle feed or execute manual settlement
  ./scripts/remediation/resolve_stuck_market.sh <MARKET_ID> [OUTCOME_ID]
  ```

### LeaderboardDrift
- **Trigger**: `abs(leaderboard_points_sum - event_points_sum) > 0`
- **Runbook**: [LEADERBOARD_REBUILD_RUNBOOK.md](LEADERBOARD_REBUILD_RUNBOOK.md)
- **Remediation**:
  ```bash
  # Recompute aggregates and refresh materialized views
  ./scripts/remediation/rebuild_leaderboard.sh
  ```

### RPCHighErrorRate
- **Trigger**: `rate(rpc_errors_total[5m]) > 0.05` for 2 minutes.
- **Runbook**: [ORACLE_ADAPTER_FRESHNESS.md](ORACLE_ADAPTER_FRESHNESS.md)
- **Remediation**:
  ```bash
  # Failover to backup Soroban RPC provider
  ./scripts/remediation/switch_rpc_provider.sh https://soroban-rpc.backup.provider.com
  ```

---

## 4. Verification & Testing

All procedures documented above have been verified with corresponding automated recovery scripts located in [`scripts/remediation/`](../scripts/remediation/).
