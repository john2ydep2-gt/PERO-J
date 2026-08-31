/**
 * SEP-41 token metadata fetcher.
 * Uses read-only simulateTransaction to retrieve name, symbol, and decimals
 * from any SEP-41 compliant contract without spending fees.
 * Note: The dummy account used for simulation must exist on the target network,
 * or the indexer's operational account should be configured.
 */
import {
  SorobanRpc,
  TransactionBuilder,
  Networks,
  Account,
  Contract,
  scValToNative,
} from "@stellar/stellar-sdk";

const RPC_URL = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE || Networks.TESTNET;
const DUMMY_SOURCE_FALLBACK =
  "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";
const OPERATIONAL_ACCOUNT = process.env.OPERATIONAL_ACCOUNT || DUMMY_SOURCE_FALLBACK;
const USING_DUMMY_SOURCE = !process.env.OPERATIONAL_ACCOUNT && !String(NETWORK_PASSPHRASE).toLowerCase().includes("testnet");

if (USING_DUMMY_SOURCE) {
  console.warn(
    "OPERATIONAL_ACCOUNT is not set for a non-testnet network; falling back to the built-in dummy source account. " +
      "This may fail if the account does not exist on the target network. Set OPERATIONAL_ACCOUNT to a funded source account."
  );
}

const rpc = new SorobanRpc.Server(RPC_URL, { allowHttp: true });
const METADATA_CACHE_TTL_MS = 60 * 60 * 1000;

const contractCache = new Map();
const metadataCache = new Map();

function getContract(contractId) {
  if (!contractCache.has(contractId)) {
    contractCache.set(contractId, new Contract(contractId));
  }
  return contractCache.get(contractId);
}

/**
 * Simulate a no-arg contract call and return the native ScVal result.
 * @param {string} contractId
 * @param {string} method
 * @param {string} [sequence="0"]
 */
async function simulateCall(contractId, method, sequence = "0") {
  const account = new Account(OPERATIONAL_ACCOUNT, sequence);
  const contract = getContract(contractId);
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method))
    .setTimeout(30)
    .build();

  const result = await rpc.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(result)) {
    const errorStr =
      typeof result.error === "string" ? result.error : JSON.stringify(result.error || "");
    const lower = errorStr.toLowerCase();
    if (
      sequence === "0" &&
      (/sourceaccountnotfound/i.test(errorStr) ||
        /source account not found/i.test(lower) ||
        /account.*not found/i.test(lower) ||
        /account.*does not exist/i.test(lower) ||
        /no account.*sequence/i.test(lower))
    ) {
      return simulateCall(contractId, method, "1");
    }
    throw new Error(`simulate ${method} failed: ${result.error}`);
  }
  const retval = result.result?.retval;
  return retval ? scValToNative(retval) : null;
}

/**
 * Fetch SEP-41 token metadata for a given contract ID.
 * @param {string} contractId  Strkey-encoded contract address
 * @returns {Promise<{ name: string, symbol: string, decimals: number }>}
 */
export async function fetchTokenMetadata(contractId) {
  const cached = metadataCache.get(contractId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const [name, symbol, decimals] = await Promise.all([
    simulateCall(contractId, "name"),
    simulateCall(contractId, "symbol"),
    simulateCall(contractId, "decimals"),
  ]);

  const metadata = {
    name: String(name ?? ""),
    symbol: String(symbol ?? ""),
    decimals: Number(decimals ?? 7),
  };
  metadataCache.set(contractId, {
    value: metadata,
    expiresAt: Date.now() + METADATA_CACHE_TTL_MS,
  });
  return metadata;
}
