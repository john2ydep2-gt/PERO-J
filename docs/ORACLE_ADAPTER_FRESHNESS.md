# Runbook: RPC Adapter Health & High Error Rate (`RPCHighErrorRate`)

## Overview
- **Alert Name**: `RPCHighErrorRate`
- **Severity**: `High`
- **Condition**: `rate(rpc_errors_total[5m]) > 0.05`
- **Service**: `rpc-adapter`
- **Escalation**: Infrastructure & Stellar Node Operators

## Symptoms
- Elevated rate of RPC failures (HTTP 429 rate limit exceeded, 502/503 bad gateway, or socket timeout errors) when communicating with the Stellar Horizon / Soroban RPC endpoint.
- Delayed event ingestion and degraded API response times.

## Verification Commands

1. **Check Live RPC Endpoint Status**:
   ```bash
   curl -s -w "\nHTTP Status: %{http_code}\nTime Total: %{time_total}s\n" \
     -X POST "${RPC_URL:-https://soroban-testnet.stellar.org}" \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
   ```

2. **Inspect Error Rate Metric in Prometheus**:
   ```promql
   sum(rate(rpc_errors_total[5m])) by (method, error_code)
   ```

3. **Check Indexer RPC Request Logs**:
   ```bash
   docker logs --tail 200 peroj-indexer-1 | grep -i "rpc.*error\|soroban.*fail"
   ```

## Remediation Procedure

1. **Failover to Alternate RPC Endpoint**:
   Switch the active RPC provider immediately using the remediation script:
   ```bash
   ./scripts/remediation/switch_rpc_provider.sh https://soroban-rpc.backup.provider.com
   ```

2. **Handle Rate Limiting (HTTP 429)**:
   - Check if the API key for the current RPC node provider has hit rate tiers or quotas.
   - Adjust request backoff and poll interval:
     Increase `INDEXER_POLL_INTERVAL_MS` from default (e.g., 5000ms to 10000ms) during degraded network periods.

3. **Verify Error Rate Stabilization**:
   Monitor the error rate in Prometheus expression browser:
   ```promql
   rate(rpc_errors_total[5m]) < 0.01
   ```
   Ensure the alert clears and transitions to resolved.
