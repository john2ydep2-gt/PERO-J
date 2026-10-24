import {
  BASE_FEE,
  Contract,
  Networks,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from "@stellar/stellar-sdk";
import type { FeeBumpTransaction, Transaction } from "@stellar/stellar-sdk";

type AnyTransaction = Transaction | FeeBumpTransaction;

const DEFAULT_RPC_URL = "https://soroban-testnet.stellar.org";
const DEFAULT_PASSPHRASE = Networks.TESTNET;
const CONFIRMATION_TIMEOUT_MS = 45_000;
const CONFIRMATION_POLL_MS = 1_500;
const SEND_RETRY_DELAY_MS = 2_000;
const SEND_RETRIES = 2;

export class BetConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BetConfigError";
  }
}

export interface BetSubmission {
  address: string;
  market: string;
  selection: string;
  odds: number;
  stake: string;
}

function rpcUrl(): string {
  return import.meta.env.VITE_SOROBAN_RPC_URL || DEFAULT_RPC_URL;
}

export function networkPassphrase(): string {
  return import.meta.env.VITE_NETWORK_PASSPHRASE || DEFAULT_PASSPHRASE;
}

function bettingContractId(): string {
  return import.meta.env.VITE_BETTING_CONTRACT_ID || "";
}

function getServer(): rpc.Server {
  return new rpc.Server(rpcUrl());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseStake(stake: string): bigint {
  const trimmed = stake.trim();
  if (!/^\d+(\.\d{1,7})?$/.test(trimmed)) {
    throw new Error("Stake must be a positive amount with at most 7 decimal places.");
  }
  const [whole, frac = ""] = trimmed.split(".");
  const units = BigInt(whole) * 10_000_000n + BigInt((frac + "0000000").slice(0, 7));
  if (units <= 0n) {
    throw new Error("Stake must be greater than zero.");
  }
  return units;
}

export async function buildAndSignBet(
  submission: BetSubmission,
  sign: (xdr: string) => Promise<string>
): Promise<{ signed: AnyTransaction; server: rpc.Server }> {
  const contractId = bettingContractId();
  if (!contractId) {
    throw new BetConfigError(
      "Betting is not configured: set VITE_BETTING_CONTRACT_ID to a deployed betting contract."
    );
  }
  if (!StrKey.isValidContract(contractId)) {
    throw new BetConfigError("VITE_BETTING_CONTRACT_ID is not a valid Soroban contract ID.");
  }
  const stake = parseStake(submission.stake);

  const server = getServer();
  let account;
  try {
    account = await server.getAccount(submission.address);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not load account ${submission.address} from ${rpcUrl()}: ${detail}`
    );
  }

  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(
      contract.call(
        "place_bet",
        nativeToScVal(submission.market, { type: "string" }),
        nativeToScVal(submission.selection, { type: "string" }),
        nativeToScVal(stake, { type: "i128" }),
        nativeToScVal(Math.round(submission.odds * 100), { type: "u32" })
      )
    )
    .setTimeout(180)
    .build();

  let prepared: Transaction;
  try {
    prepared = await server.prepareTransaction(tx);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`The bet transaction could not be prepared: ${detail}`);
  }

  const signedXdr = await sign(prepared.toXDR());
  const signed = TransactionBuilder.fromXDR(signedXdr, networkPassphrase());
  return { signed, server };
}

export async function sendBetTransaction(
  signed: AnyTransaction,
  server: rpc.Server
): Promise<string> {
  let lastStatus = "";
  for (let attempt = 0; attempt <= SEND_RETRIES; attempt++) {
    const result = await server.sendTransaction(signed);
    if (result.status === "ERROR") {
      throw new Error("The network rejected the signed bet transaction.");
    }
    if (result.status === "TRY_AGAIN_LATER") {
      lastStatus = result.status;
      if (attempt < SEND_RETRIES) {
        await sleep(SEND_RETRY_DELAY_MS);
        continue;
      }
      throw new Error("The Stellar network is congested. Please try again in a moment.");
    }
    return result.hash;
  }
  throw new Error(`The bet transaction could not be submitted (status: ${lastStatus}).`);
}

export async function waitForConfirmation(
  hash: string,
  server: rpc.Server
): Promise<{ ledger: number }> {
  const deadline = Date.now() + CONFIRMATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(CONFIRMATION_POLL_MS);
    let response;
    try {
      response = await server.getTransaction(hash);
    } catch {
      continue;
    }
    if (response.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return { ledger: response.ledger };
    }
    if (response.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error("The bet transaction failed on-chain.");
    }
  }
  throw new Error("Timed out waiting for the bet to be confirmed on-chain.");
}
