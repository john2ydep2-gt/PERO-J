# Runbook: Leaderboard Inconsistency Rebuild (`LeaderboardDrift`)

## Overview
- **Alert Name**: `LeaderboardDrift`
- **Severity**: `Medium` / `High`
- **Condition**: `abs(leaderboard_points_sum - event_points_sum) > 0`
- **Service**: `indexer` / `database`
- **Escalation**: Backend & Analytics Engineers

## Symptoms
- Player ranks, points, or win-loss balances displayed on the frontend do not match actual on-chain transaction outcomes.
- Discrepancy detected between event log sums and cached leaderboard aggregate tables.

## Verification Commands

1. **Verify Discrepancy in Database**:
   ```sql
   -- Compare calculated score with materialized leaderboard score
   SELECT
     u.address,
     u.points AS cached_points,
     COALESCE(SUM(b.payout - b.amount), 0) AS actual_points,
     (u.points - COALESCE(SUM(b.payout - b.amount), 0)) AS drift
   FROM users u
   LEFT JOIN bets b ON b.user_address = u.address
   GROUP BY u.address, u.points
   HAVING u.points != COALESCE(SUM(b.payout - b.amount), 0);
   ```

2. **Check Leaderboard Rebuild Endpoint**:
   ```bash
   curl -s http://localhost:3001/api/leaderboard/status | jq .
   ```

## Remediation Procedure

1. **Trigger Automated Leaderboard Rebuild**:
   Execute the remediation script:
   ```bash
   ./scripts/remediation/rebuild_leaderboard.sh
   ```

2. **Database View Refresh (Direct SQL)**:
   If using materialized views for the leaderboard, refresh concurrently:
   ```sql
   REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_summary;
   ```

3. **Verify Re-synchronization**:
   Re-run the verification query to confirm drift equals zero.
   Verify the alert resolves in Prometheus:
   ```promql
   leaderboard_points_sum - event_points_sum == 0
   ```
