# Runbook: Indexer Stalled (`IndexerStalled`)

## Overview
- **Alert Name**: `IndexerStalled`
- **Severity**: `Critical`
- **Condition**: `indexer_lag_ledgers > 100` for 3 minutes
- **Service**: `indexer`
- **Escalation**: Infrastructure & Protocol Core Engineers

## Symptoms
- Indexer falls more than 100 ledgers behind the Stellar network ledger head.
- Users see delayed contract event indexing, stale prediction market odds, and pending transaction statuses.

## Verification Commands

1. **Check Indexer Health and Lag**:
   ```bash
   curl -s http://localhost:3001/api/health | jq .
   ```

2. **Query Current Stellar Network Head vs Indexer Last Ingested Ledger**:
   ```bash
   # Query Stellar RPC latest ledger
   curl -s -X POST https://soroban-testnet.stellar.org \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' | jq .result.sequence

   # Query Indexer DB max ledger sequence
   psql -h localhost -U peroj -d peroj -c "SELECT MAX(ledger_sequence) FROM events;"
   ```

3. **Check Container Logs for Crashes or Exceptions**:
   ```bash
   docker logs --tail 100 peroj-indexer-1
   ```

4. **Verify Database Connection Pool Availability**:
   ```bash
   psql -h localhost -U peroj -d peroj -c "SELECT count(*) FROM pg_stat_activity WHERE datname='peroj';"
   ```

## Remediation Procedure

1. **Automated / Rapid Restart**:
   Execute the remediation script:
   ```bash
   ./scripts/remediation/restart_indexer.sh
   ```

2. **Database Connection Pool Saturation**:
   If the database connection pool is saturated, increase `DATABASE_POOL_SIZE` in the environment configuration or kill hung idle sessions:
   ```sql
   SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = 'idle in transaction' AND state_change < current_timestamp - interval '5 minutes';
   ```

3. **RPC Rate Limiting or Stalls**:
   If indexer logs indicate rate-limit errors (HTTP 429) from the Stellar RPC endpoint, failover to a fallback RPC node:
   ```bash
   ./scripts/remediation/switch_rpc_provider.sh https://soroban-rpc.backup.provider.com
   ```

4. **Catch-up Sync Verification**:
   Monitor the ledger lag gauge in Prometheus:
   ```promql
   indexer_lag_ledgers
   ```
   Ensure lag decreases monotonically down to < 5 ledgers. Once resolved, Alertmanager sends a resolution notification.
