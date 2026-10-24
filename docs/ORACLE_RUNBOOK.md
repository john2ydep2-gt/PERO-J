# Runbook: Stuck Market Resolution (`MarketStuck` / `MarketStuckInUnresolved`)

## Overview
- **Alert Name**: `MarketStuck` / `MarketStuckInUnresolved`
- **Severity**: `Critical`
- **Condition**: `count(markets{status="open", ends_at_elapsed_hours > 48}) > 0` for 5 minutes
- **Service**: `oracle`
- **Escalation**: Operations Team & Oracle Multisig Keyholders

## Symptoms
- One or more prediction markets have passed their closing time by more than 48 hours without being resolved or finalized.
- User collateral remains locked in the contract, preventing payout claims.

## Verification Commands

1. **Identify Stuck Markets**:
   Query Prometheus or the Indexer database for stuck markets:
   ```bash
   # Query indexer API for expired unresolved markets
   curl -s "http://localhost:3001/api/markets?status=open&expired=true" | jq .
   ```

2. **Query Database for Stuck Market Details**:
   ```sql
   SELECT id, title, ends_at, status, resolution_source
   FROM markets
   WHERE status = 'open' AND ends_at < NOW() - INTERVAL '48 hours';
   ```

3. **Check Oracle Daemon Ingestion Logs**:
   ```bash
   docker logs --tail 100 peroj-oracle-daemon-1 | grep -i "error\|timeout\|unresolved"
   ```

## Remediation Procedure

1. **Verify External Oracle Feed Availability**:
   Check if the underlying oracle API (e.g., Pyth, Band, Reflector, or custom price feed) has reported a final price or outcome for the target market identifier.

2. **Retry Oracle Poll / Refresh**:
   If the oracle provider had a transient outage that is now recovered, re-trigger oracle polling:
   ```bash
   ./scripts/remediation/resolve_stuck_market.sh <MARKET_ID>
   ```

3. **Manual / Emergency Settlement**:
   If the oracle feed is permanently defunct or disputed, invoke manual settlement via the admin key or council multisig:
   ```bash
   ./scripts/remediation/resolve_stuck_market.sh <MARKET_ID> <WINNING_OUTCOME_ID>
   ```

4. **Escalate to Council (if disputed)**:
   If the market is disputed and cannot be resolved by standard oracle feeds, trigger governance escalation to open a council voting round per `docs/COUNCIL_RUNBOOK.md`.
