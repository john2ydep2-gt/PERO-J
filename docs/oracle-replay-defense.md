# Oracle Replay Attack Defenses

## 1. Context & Threat Model

External oracle providers sign outcome attestations off-chain for resolution of prediction markets.
Without domain separation, nonce tracking, and expiration enforcement, an attacker could intercept a valid attestation from one market or chain and replay it on:
- Another market with similar questions/outcomes.
- A different network environment (e.g. Testnet vs. Mainnet).
- The same market at a later time after market conditions have changed.

## 2. Specification & Cryptographic Standard

Every off-chain oracle attestation must conform to the following schema:

```json
{
  "domain": "PERO-J_ORACLE_ATTESTATION_V1",
  "chain_id": "testnet",
  "market_id": "market-stellar-42",
  "nonce": "c479e0a8-b649-43c2-a89e-2fe68774e1d1",
  "timestamp": 1729440000000,
  "outcome": {
    "winner": "OPTION_A",
    "final_value": "120.5"
  },
  "provider_id": "GB... (Stellar Ed25519 Public Key)",
  "signature": "<Hex or Base64 Ed25519 Signature>"
}
```

### Defense Layers

1. **Domain Separation**:
   Payloads strictly enforce `domain: "PERO-J_ORACLE_ATTESTATION_V1"`. Attestations intended for other protocols or versions are discarded immediately.
2. **Context Binding**:
   `chain_id` and `market_id` are bound inside the canonical signed message hash. Cross-market and cross-chain replay attempts fail signature validation.
3. **Freshness Window (5-Minute Expiry)**:
   Payloads must have a `timestamp` within 5 minutes (`300,000 ms`) of system time (`MAX_TIMESTAMP_AGE_MS`). Older signatures are rejected with `400 SIGNATURE_EXPIRED`. Clock drift is capped at 60 seconds into the future.
4. **Database Nonce Consumption (`consumed_oracle_nonces`)**:
   Every used nonce is recorded in a PostgreSQL table with a composite primary key / unique constraint:
   ```sql
   CREATE TABLE consumed_oracle_nonces (
     provider_id TEXT NOT NULL,
     nonce       TEXT NOT NULL,
     market_id   TEXT NOT NULL,
     chain_id    TEXT NOT NULL,
     timestamp   TIMESTAMPTZ NOT NULL,
     created_at  TIMESTAMPTZ DEFAULT NOW(),
     PRIMARY KEY (provider_id, nonce)
   );
   ```
   If a duplicate nonce is submitted for the same provider, the API rejects it with `409 REPLAY_DETECTED`.

## 3. API Integration

### Submit Attestation
```http
POST /api/oracle/attestations
Content-Type: application/json

{
  "domain": "PERO-J_ORACLE_ATTESTATION_V1",
  "chain_id": "testnet",
  "market_id": "market-101",
  "nonce": "unique-uuid-v4",
  "timestamp": 1729440000000,
  "outcome": { "result": "YES" },
  "provider_id": "GAKQ...",
  "signature": "3a7b..."
}
```

**Responses**:
- `201 Created`: Verified and nonce consumed.
- `400 Bad Request`: Expired timestamp or missing parameters.
- `401 Unauthorized`: Invalid signature.
- `409 Conflict`: Replay detected (nonce already consumed).
