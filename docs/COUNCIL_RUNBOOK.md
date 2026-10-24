# Runbook: Dispute Council Voting Inactivity (`CouncilVoteStalled`)

## Overview
- **Alert Name**: `CouncilVoteStalled`
- **Severity**: `High`
- **Condition**: `count(disputes{status="escalated", elapsed_hours > 24, votes_cast < 4}) > 0`
- **Service**: `governance`
- **Escalation**: Dispute Council Quorum & Governance Operations

## Symptoms
- An escalated prediction market dispute has exceeded the 24-hour voting window without reaching the 4-vote quorum requirement.
- Dispute settlement is stalled, delaying user fund distribution.

## Verification Commands

1. **Check Stalled Disputes**:
   ```bash
   curl -s "http://localhost:3001/api/disputes?status=escalated" | jq '.[] | select(.votes_cast < 4)'
   ```

2. **Query Database for Pending Council Votes**:
   ```sql
   SELECT id, market_id, status, votes_cast, created_at
   FROM disputes
   WHERE status = 'escalated' AND votes_cast < 4 AND created_at < NOW() - INTERVAL '24 hours';
   ```

## Remediation Procedure

1. **Page Council Quorum Members**:
   - Send urgent notification to council emergency multisig holders via Discord `#council-governance` and SMS/PagerDuty.
   - Provide direct link to the voting portal: `https://app.peroj.network/disputes/<DISPUTE_ID>`.

2. **Emergency Fallback (if quorum unreachable)**:
   - If council members are offline past 48 hours, follow protocol charter Article IV (Emergency Governor fallback vote or protocol multisig resolution).
