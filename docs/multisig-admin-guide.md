# Multi-Signature Admin Key Requirement & Operator Guide

## 1. Overview & Threat Model

Contract administration, contract upgrades (`upgrade`), and platform fee withdrawals (`withdraw_fees`) are critical protocol operations.
Authorizing these actions via a single Stellar keypair introduces a single point of failure (hot key compromise, operator error, or malicious insider).

To eliminate this vulnerability, the PERO-J protocol transitions contract admin authorization to a **3-of-5 threshold multi-signature account enforced at the Stellar ledger protocol level**.

## 2. Stellar Protocol-Level Multi-Signature Architecture

Stellar accounts natively enforce multi-signature rules on every transaction envelope and Soroban authorization tree:
- **Signer Weights**: 5 independent team member hardware/cold keypairs are configured as signers with `weight = 1` each.
- **Master Key Revocation**: The initial master keypair has its weight set to `0` (`masterWeight: 0`).
- **Account Thresholds**:
  - `low_threshold`: 3 (allows transaction fee bumping, sequence number management)
  - `med_threshold`: 3 (standard operations)
  - `high_threshold`: 3 (contract administration, `set_options`, WASM upgrades, fee withdrawals)

Because the threshold is 3 and every individual signer has a weight of 1:
- **No single key** can authorize contract upgrades or withdraw fees.
- Any unauthorized attempt signed by 1 or 2 keys is rejected by Stellar validators before ledger consensus.
- A quorum of at least **3 out of 5** authorized signers must sign the transaction envelope.

## 3. Account Provisioning

To configure an existing admin account into a 3-of-5 multi-sig setup:

```bash
./scripts/setup-multisig-admin.sh \
  "$ADMIN_SECRET_KEY" \
  "$SIGNER_PUBKEY_1" \
  "$SIGNER_PUBKEY_2" \
  "$SIGNER_PUBKEY_3" \
  "$SIGNER_PUBKEY_4" \
  "$SIGNER_PUBKEY_5"
```

Verify account threshold status:
```bash
curl -s "https://horizon-testnet.stellar.org/accounts/<ADMIN_ACCOUNT_ID>" | jq '{thresholds, signers}'
```

Expected response:
```json
{
  "thresholds": {
    "low_threshold": 3,
    "med_threshold": 3,
    "high_threshold": 3
  },
  "signers": [
    { "key": "<SIGNER_1>", "weight": 1 },
    { "key": "<SIGNER_2>", "weight": 1 },
    { "key": "<SIGNER_3>", "weight": 1 },
    { "key": "<SIGNER_4>", "weight": 1 },
    { "key": "<SIGNER_5>", "weight": 1 }
  ]
}
```

## 4. Operator Signing Workflow

### Step 1: Draft Transaction Envelope (Initiator)
The initiating operator builds the Soroban transaction (e.g. `upgrade(new_wasm_hash)` or `withdraw_fees(token, to, amount)`) with source account set to the multi-sig admin address and sequence number bumped. The unsigned transaction is exported as base64 XDR:

```bash
soroban contract invoke \
  --id "$CONTRACT_ID" \
  --source-account "$ADMIN_ACCOUNT_ID" \
  --build-only \
  -- upgrade --new_wasm_hash "$NEW_WASM_HASH" > unsigned_upgrade.xdr
```

### Step 2: Review & Sign (Signers 1, 2, 3)
Each designated key holder inspects the transaction envelope to verify the parameters (target contract, new WASM hash, destination address, and fee amount).
Signers sign the envelope sequentially or combine detached signatures:

```bash
# Signer 1
stellar tx sign --network testnet --source "$SIGNER_1_KEY" unsigned_upgrade.xdr > signed_1.xdr

# Signer 2
stellar tx sign --network testnet --source "$SIGNER_2_KEY" signed_1.xdr > signed_2.xdr

# Signer 3 (Quorum Reached)
stellar tx sign --network testnet --source "$SIGNER_3_KEY" signed_2.xdr > fully_signed.xdr
```

Alternatively, use `scripts/multisig-admin-tx.ts` for automated multi-signer envelope aggregation.

### Step 3: Broadcast & On-Chain Verification
Submit the multi-signed envelope to Horizon or Soroban RPC:

```bash
stellar tx send fully_signed.xdr --network testnet
```

The smart contract emits `(symbol_short!("adm_upg"), new_wasm_hash)` or `(symbol_short!("fee_wd"), (token, to, amount))`.

## 5. Emergency Key Rotation
If a signer key is compromised or an operator leaves the team:
1. Initiate a `set_options` transaction signed by 3 of the remaining active signers.
2. Remove the revoked signer (`weight: 0`) and register a replacement signer (`weight: 1`).
3. Retain the threshold of 3.
