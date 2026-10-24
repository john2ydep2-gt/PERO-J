#!/usr/bin/env bash
set -euo pipefail

# setup-multisig-admin.sh
#
# Configures a Stellar account as a 3-of-5 threshold multi-signature account
# for contract administration, upgrades, and fee withdrawals.
#
# Enforces protocol-level authorization rules:
# - Thresholds: low=3, medium=3, high=3
# - 5 Signers with weight 1 each
# - Master key weight revoked (set to 0) to prevent single-key unilateral action.

HORIZON_URL="${HORIZON_URL:-https://horizon-testnet.stellar.org}"
NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"

if [ "$#" -lt 6 ]; then
  echo "Usage: $0 <ADMIN_SECRET_KEY> <SIGNER_PUBKEY_1> <SIGNER_PUBKEY_2> <SIGNER_PUBKEY_3> <SIGNER_PUBKEY_4> <SIGNER_PUBKEY_5>"
  echo ""
  echo "Configures a 3-of-5 multi-signature threshold on the admin account."
  exit 1
fi

ADMIN_SECRET="$1"
SIGNER_1="$2"
SIGNER_2="$3"
SIGNER_3="$4"
SIGNER_4="$5"
SIGNER_5="$6"

echo "=== Initializing Multi-Signature Admin Configuration (3-of-5) ==="
echo "Target Network: $HORIZON_URL"
echo "Signer 1: $SIGNER_1 (weight: 1)"
echo "Signer 2: $SIGNER_2 (weight: 1)"
echo "Signer 3: $SIGNER_3 (weight: 1)"
echo "Signer 4: $SIGNER_4 (weight: 1)"
echo "Signer 5: $SIGNER_5 (weight: 1)"
echo "Configuring account signers and thresholds at protocol level..."

# We execute the Node/TS multi-sig configuration tool
node -e '
const { Keypair, Horizon, Operation, TransactionBuilder, Networks } = require("@stellar/stellar-sdk");

async function configureMultiSig() {
  const adminSecret = process.argv[1];
  const signers = process.argv.slice(2, 7);
  const horizonUrl = process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";
  const server = new Horizon.Server(horizonUrl);

  const adminKeypair = Keypair.fromSecret(adminSecret);
  const account = await server.loadAccount(adminKeypair.publicKey());

  let builder = new TransactionBuilder(account, {
    fee: "10000",
    networkPassphrase: process.env.NETWORK_PASSPHRASE || Networks.TESTNET,
  });

  // Add 5 signers with weight 1
  for (const signer of signers) {
    builder.addOperation(
      Operation.setOptions({
        signer: { ed25519PublicKey: signer, weight: 1 },
      })
    );
  }

  // Set low/med/high thresholds to 3 and revoke master key weight to 0
  builder.addOperation(
    Operation.setOptions({
      masterWeight: 0,
      lowThreshold: 3,
      medThreshold: 3,
      highThreshold: 3,
    })
  );

  builder.setTimeout(60);
  const tx = builder.build();
  tx.sign(adminKeypair);

  console.log("Submitting multi-sig configuration transaction...");
  const resp = await server.submitTransaction(tx);
  console.log("Multi-sig configuration successful! Tx Hash:", resp.hash);
}

configureMultiSig().catch((err) => {
  console.error("Multi-sig configuration failed:", err.message);
  process.exit(1);
});
' "$ADMIN_SECRET" "$SIGNER_1" "$SIGNER_2" "$SIGNER_3" "$SIGNER_4" "$SIGNER_5"

echo "=== Verification ==="
echo "Admin account transitioned to 3-of-5 protocol-level multi-signature."
