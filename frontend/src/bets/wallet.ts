import { StrKey } from "@stellar/stellar-sdk";

export interface FreighterWallet {
  requestAccess(): Promise<{ address: string } | { error: string }>;
  signTransaction(
    xdr: string,
    opts?: { network?: string; networkPassphrase?: string; address?: string }
  ): Promise<{ signedTxXdr: string; signerAddress?: string } | { error: string }>;
}

declare global {
  interface Window {
    freighterApi?: FreighterWallet;
  }
}

export class WalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletError";
  }
}

function getFreighter(): FreighterWallet {
  const freighter = typeof window !== "undefined" ? window.freighterApi : undefined;
  if (!freighter) {
    throw new WalletError(
      "No Stellar wallet extension found. Install Freighter to place bets, then reload the page."
    );
  }
  return freighter;
}

export async function connectWallet(): Promise<string> {
  const freighter = getFreighter();
  const result = await freighter.requestAccess();
  if ("error" in result) {
    throw new WalletError(result.error || "Wallet connection was rejected.");
  }
  if (!StrKey.isValidEd25519PublicKey(result.address)) {
    throw new WalletError("The wallet returned an invalid Stellar address.");
  }
  return result.address;
}

export async function signTransactionXdr(
  xdr: string,
  address: string,
  networkPassphrase: string
): Promise<string> {
  const freighter = getFreighter();
  const result = await freighter.signTransaction(xdr, { networkPassphrase, address });
  if ("error" in result) {
    throw new WalletError(result.error || "The transaction was not signed.");
  }
  if (!result.signedTxXdr) {
    throw new WalletError("The wallet returned an empty signature.");
  }
  return result.signedTxXdr;
}
