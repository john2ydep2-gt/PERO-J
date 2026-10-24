# Contract Upgrade Playbook

This document describes the end-to-end procedure for upgrading the
**PERO-J on-chain contract** (`soroban-explorer-contract`) on Stellar.
Follow every step in order.  Do not skip stages or combine environments.

> **Who may execute this playbook:** The current contract admin key-holder
> (or multi-sig quorum).  Coordinate with the indexer on-call engineer
> before any mainnet execution.

---

## Table of Contents

1. [Pre-upgrade checklist](#1-pre-upgrade-checklist)
2. [Build optimised WASM and compute SHA-256 hash](#2-build-optimised-wasm-and-compute-sha-256-hash)
3. [Deploy and test on Testnet](#3-deploy-and-test-on-testnet)
4. [Verify WASM hash identity against the deployed contract](#4-verify-wasm-hash-identity-against-the-deployed-contract)
5. [Execute multi-sig admin upgrade on Mainnet](#5-execute-multi-sig-admin-upgrade-on-mainnet)
6. [Post-upgrade verification](#6-post-upgrade-verification)
7. [Rollback procedure](#7-rollback-procedure)
8. [Abort contingencies](#8-abort-contingencies)
9. [RPO / RTO and data-safety notes](#9-rpo--rto-and-data-safety-notes)

---

## 1. Pre-upgrade checklist

Complete every item before touching any environment.

- [ ] All contract unit tests pass on the target branch:
  ```bash
  cargo test -p soroban-explorer-contract
  ```
- [ ] The change has been code-reviewed and merged to `main`.
- [ ] A database backup has been taken and verified (see `docs/backup.md`):
  ```bash
  make backup
  make backup-restore
  ```
- [ ] The indexer is healthy: `GET /health` returns HTTP 200 and
  `lag_seconds < 30`.
- [ ] Maintenance window communicated to all stakeholders (allow ≥ 2 h).
- [ ] The admin key (or multi-sig participants) is available and unlocked.
- [ ] The Stellar CLI is up to date:
  ```bash
  stellar --version
  ```
- [ ] You are connected to the correct network (confirm with
  `stellar network ls`).

---

## 2. Build optimised WASM and compute SHA-256 hash

All builds must happen from a **clean working tree** at the exact commit that
will be deployed.

```bash
# 1. Ensure a clean tree.
git status          # must be clean
git log --oneline -1  # note the commit SHA

# 2. Build the release WASM.
make build
# Produces:
#   target/wasm32-unknown-unknown/release/soroban_explorer_contract.wasm
#   target/wasm32-unknown-unknown/release/soroban_explorer_contract.optimized.wasm

# 3. Compute and record the SHA-256 hash of the optimised binary.
sha256sum target/wasm32-unknown-unknown/release/soroban_explorer_contract.optimized.wasm
```

**Record the hash** — you will verify it in steps 4 and 5.  Example output:

```
3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4  soroban_explorer_contract.optimized.wasm
```

> Do not proceed unless you have recorded the hash.

---

## 3. Deploy and test on Testnet

### 3a. Upload WASM to Testnet

```bash
# Upload the WASM bytecode (does NOT yet update the live contract).
stellar contract upload \
  --wasm target/wasm32-unknown-unknown/release/soroban_explorer_contract.optimized.wasm \
  --source default \
  --network testnet
```

The command prints a **WASM hash** (the Stellar network's hash of the uploaded
bytecode).  This must match the `sha256sum` from step 2 — confirm before
continuing.

### 3b. Run automated migration tests

Start a local testnet stack and run the full integration suite against the
*new* WASM:

```bash
# Build Docker images with the new contract.
make e2e-build

# Start the stack (Stellar sandbox + Postgres + indexer + frontend).
make e2e-up

# Deploy the new contract and seed test data.
make e2e-deploy

# Run end-to-end tests.
make e2e-test
```

All tests must pass.  If any test fails, stop here and fix the issue before
proceeding to mainnet.

### 3c. Upgrade the Testnet contract instance

```bash
# Invoke the Soroban upgrade host function on the existing testnet contract.
stellar contract invoke \
  --id "$TESTNET_CONTRACT_ID" \
  --source default \
  --network testnet \
  -- \
  upgrade \
  --new_wasm_hash <WASM_HASH_FROM_3A>
```

Verify the upgrade took effect:

```bash
stellar contract read \
  --id "$TESTNET_CONTRACT_ID" \
  --network testnet
```

Confirm the returned metadata version matches the new build.

### 3d. Smoke-test the upgraded Testnet contract

```bash
# Check that existing events are still retrievable.
stellar contract invoke \
  --id "$TESTNET_CONTRACT_ID" \
  --network testnet \
  -- event_count

# Check that new events can still be submitted.
stellar contract invoke \
  --id "$TESTNET_CONTRACT_ID" \
  --source default \
  --network testnet \
  -- submit_event \
  --caller "$ADMIN_ADDRESS" \
  --contract_id "0000000000000000000000000000000000000000000000000000000000000001" \
  --function "smoke" \
  --ledger 1 \
  --description "upgrade smoke test" \
  --raw_topics '[]' \
  --raw_data ""
```

Both calls must succeed before proceeding.

---

## 4. Verify WASM hash identity against the deployed contract

Before touching mainnet, confirm the WASM hash in the deployed Testnet
contract bytecodes matches the local build.

```bash
# Retrieve the on-chain WASM hash of the upgraded Testnet contract.
stellar contract inspect \
  --wasm-hash <WASM_HASH_FROM_3A> \
  --network testnet

# Compare with the local sha256sum from step 2.
# The Stellar network stores a SHA-256 hash of the uploaded bytecode.
# They MUST be identical.
```

If the hashes differ, **abort**.  The contract on-chain does not match what
you built.  Investigate the discrepancy before proceeding.

> This byte-for-byte hash comparison is the single most important integrity
> check in the upgrade process.  It guards against supply-chain attacks,
> build-environment tampering, and accidental use of a stale WASM binary.

---

## 5. Execute multi-sig admin upgrade on Mainnet

> **This step is irreversible.**  Pause and re-read the checklist from step 1
> before executing.

### 5a. Upload WASM to Mainnet

```bash
stellar contract upload \
  --wasm target/wasm32-unknown-unknown/release/soroban_explorer_contract.optimized.wasm \
  --source default \
  --network mainnet
```

Record the WASM hash printed by the command and verify it matches step 2.

### 5b. Build the upgrade transaction (offline)

If the admin account is a multi-sig account, build and sign the transaction
without broadcasting:

```bash
# Build and sign locally (signer 1).
stellar contract invoke \
  --id "$MAINNET_CONTRACT_ID" \
  --source signer1 \
  --network mainnet \
  --build-only \
  -- \
  upgrade \
  --new_wasm_hash <MAINNET_WASM_HASH_FROM_5A> \
  > upgrade_tx.xdr

# Have signer 2 inspect and countersign.
stellar tx sign upgrade_tx.xdr \
  --sign-with-key signer2 \
  --network mainnet
```

### 5c. Broadcast the signed transaction

```bash
stellar tx send upgrade_tx.xdr --network mainnet
```

Note the transaction hash printed.  Keep it for the incident log.

---

## 6. Post-upgrade verification

Run every check within **15 minutes** of the upgrade broadcast.

```bash
# 1. Confirm the new WASM hash is active on-chain.
stellar contract inspect \
  --wasm-hash <MAINNET_WASM_HASH_FROM_5A> \
  --network mainnet

# 2. Verify the indexer reconnected and is no longer lagging.
curl https://<your-indexer>/health
# Expected: HTTP 200, lag_seconds < 30

# 3. Confirm events can still be read.
stellar contract invoke \
  --id "$MAINNET_CONTRACT_ID" \
  --network mainnet \
  -- event_count

# 4. Submit a canary event from the indexer hot-wallet.
stellar contract invoke \
  --id "$MAINNET_CONTRACT_ID" \
  --source indexer-hot-wallet \
  --network mainnet \
  -- submit_event \
  --caller "$INDEXER_ADDRESS" \
  --contract_id "0000000000000000000000000000000000000000000000000000000000000001" \
  --function "canary" \
  --ledger 1 \
  --description "post-upgrade canary" \
  --raw_topics '[]' \
  --raw_data ""

# 5. Verify the canary event appears via the REST API.
curl "https://<your-indexer>/api/events?limit=1"
```

If all checks pass, the upgrade is complete.  Update the incident log and
close the maintenance window.

---

## 7. Rollback procedure

There is no in-place downgrade path for Soroban contract WASM — the storage
layout may have changed.  Rollback is therefore a **re-deploy** of the
previous WASM version.

### 7a. Prepare the previous WASM

```bash
# Check out the previous release tag.
git checkout v<previous-version>

# Rebuild.
make build

# Compute hash.
sha256sum target/wasm32-unknown-unknown/release/soroban_explorer_contract.optimized.wasm
```

### 7b. Upload and upgrade to the previous WASM

Follow steps 5a–5c using the previous WASM hash.  The contract storage remains
intact; only the execution bytecode reverts.

### 7c. Verify rollback

Repeat all checks from step 6.

> **Database state is unaffected by a contract rollback.** The off-chain
> PostgreSQL database holds its own copy of decoded events; a contract rollback
> does not alter or delete any database rows.  If the database itself needs to
> be restored, follow `docs/backup.md`.

---

## 8. Abort contingencies

| Situation | Action |
|-----------|--------|
| Build hash mismatch in step 4 | Stop. Investigate build environment. Do not upload to mainnet. |
| `e2e-test` failures in step 3b | Stop. Fix the failing tests on a new branch and restart the playbook. |
| Mainnet transaction fails | Check the Stellar error code. Common causes: insufficient fees, wrong nonce, auth missing. Retry after resolving; the contract state is unchanged until the transaction succeeds. |
| Indexer stops indexing after upgrade | Check `/health`. If `lag_seconds > 30`, restart the indexer process. If the contract ABI changed, update the indexer decoder before restarting. |
| Admin key unavailable | Do not proceed. Reschedule the upgrade when the key-holder is available. |
| Unexpected on-chain state after upgrade | Engage all admin key-holders, freeze new submissions by removing indexer addresses (`remove_indexer`), investigate, then decide whether to roll back or proceed with a hotfix. |

---

## 9. RPO / RTO and data-safety notes

- **RPO (off-chain data):** ≤ 24 h with nightly base backups; ≤ 5 min with
  WAL archiving enabled.  See `docs/backup.md`.
- **RPO (on-chain data):** zero — the Stellar ledger is append-only and
  immutable.  Historical events already stored in the contract are never
  lost by an upgrade.
- **RTO:** ≤ 1 h for a full off-chain database restore.  Contract upgrades
  themselves are instantaneous (single Stellar transaction).
- **Storage migration:** If the upgrade changes the `ContractMeta` or
  `DecodedEvent` struct layout, write and test a migration script before
  executing step 3b.  Migration scripts should be idempotent.
- **TTL hygiene:** After an upgrade confirm the `Admin` and `EventSeq`
  persistent storage entries still have healthy TTLs
  (`env.storage().persistent().get_ttl(&DataKey::Admin)`).  The contract's
  `bump_ttl` helper is called on every mutating entry point, so a single
  post-upgrade transaction (e.g. the canary event in step 6) will refresh
  all TTLs.
