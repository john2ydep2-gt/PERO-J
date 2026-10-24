/**
 * multisig-admin-tx.ts
 *
 * Facilitates the 3-of-5 multi-signature transaction workflow for PERO-J contract
 * administration, contract upgrades, and platform fee withdrawals.
 *
 * Workflow:
 * 1. Initiator builds the unsigned transaction envelope with the contract invocation.
 * 2. Signers individually inspect and sign the XDR transaction envelope.
 * 3. Once at least 3 valid signatures are attached, the envelope is submitted to Horizon / Soroban RPC.
 */

import {
  Horizon,
  Keypair,
  Networks,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

export interface MultiSigAdminConfig {
  horizonUrl: string;
  networkPassphrase: string;
  adminAccountId: string;
  requiredSignatures: number; // default: 3
}

export class MultiSigAdminManager {
  private server: Horizon.Server;
  private config: MultiSigAdminConfig;

  constructor(config: Partial<MultiSigAdminConfig> & { adminAccountId: string }) {
    this.config = {
      horizonUrl: config.horizonUrl || "https://horizon-testnet.stellar.org",
      networkPassphrase: config.networkPassphrase || Networks.TESTNET,
      adminAccountId: config.adminAccountId,
      requiredSignatures: config.requiredSignatures || 3,
    };
    this.server = new Horizon.Server(this.config.horizonUrl);
  }

  /**
   * Verify account thresholds and signer weights on the Stellar network.
   */
  async verifyAccountThresholds(): Promise<{
    low: number;
    med: number;
    high: number;
    signers: Array<{ key: string; weight: number }>;
    isMultiSigEnforced: boolean;
  }> {
    const account = await this.server.loadAccount(this.config.adminAccountId);
    const low = account.thresholds.low_threshold;
    const med = account.thresholds.med_threshold;
    const high = account.thresholds.high_threshold;

    const signers = account.signers.map((s) => ({
      key: s.key,
      weight: s.weight,
    }));

    // Enforce that single key cannot meet threshold
    const maxSingleWeight = Math.max(...signers.map((s) => s.weight));
    const isMultiSigEnforced =
      med >= this.config.requiredSignatures &&
      high >= this.config.requiredSignatures &&
      maxSingleWeight < med;

    return {
      low,
      med,
      high,
      signers,
      isMultiSigEnforced,
    };
  }

  /**
   * Attaches a co-signer signature to an existing Transaction XDR envelope.
   */
  addSignerToEnvelope(xdrEnvelope: string, signerSecret: string): string {
    const keypair = Keypair.fromSecret(signerSecret);
    const tx = TransactionBuilder.fromXDR(
      xdrEnvelope,
      this.config.networkPassphrase
    ) as Transaction;

    tx.sign(keypair);
    return tx.toXDR();
  }

  /**
   * Evaluates if transaction has sufficient signers to meet the threshold.
   */
  async checkThresholdMet(xdrEnvelope: string): Promise<boolean> {
    const tx = TransactionBuilder.fromXDR(
      xdrEnvelope,
      this.config.networkPassphrase
    ) as Transaction;
    const signaturesCount = tx.signatures.length;
    return signaturesCount >= this.config.requiredSignatures;
  }

  /**
   * Submits the fully-signed multi-signature transaction to the network.
   */
  async submitTransaction(xdrEnvelope: string) {
    const isReady = await this.checkThresholdMet(xdrEnvelope);
    if (!isReady) {
      throw new Error(
        `Cannot submit multi-sig transaction: requires at least ${this.config.requiredSignatures} signatures.`
      );
    }
    const tx = TransactionBuilder.fromXDR(
      xdrEnvelope,
      this.config.networkPassphrase
    ) as Transaction;
    return await this.server.submitTransaction(tx);
  }
}
