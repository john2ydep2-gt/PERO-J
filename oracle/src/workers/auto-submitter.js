import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { adapters, categoryAdapters } from "../adapters.js";

const execFileAsync = promisify(execFile);

/**
 * Query every adapter mapped to the market's category and require unanimous
 * agreement. Any adapter failure or disagreement throws, aborting submission.
 *
 * @param {{ category: string, params: object }} market
 * @param {typeof adapters} [impl]
 * @returns {Promise<boolean>}
 */
export async function determineOutcome(market, impl = adapters) {
  const names = categoryAdapters[market.category];
  if (!names) {
    throw new Error(`no adapters configured for category "${market.category}"`);
  }
  const outcomes = await Promise.all(names.map((n) => impl[n](market.params)));
  if (new Set(outcomes).size !== 1) {
    throw new Error(
      `adapters disagree for market ${market.id}: ${outcomes.join(",")}`,
    );
  }
  return outcomes[0];
}

/**
 * Call Soroban `submit_outcome` using the protocol hot wallet, attaching the
 * configured submitter bond.
 *
 * @param {string} marketId
 * @param {boolean} outcome
 */
export async function submitOutcomeOnChain(marketId, outcome) {
  await execFileAsync("soroban", [
    "contract",
    "invoke",
    "--id",
    process.env.PERO_MARKET_CONTRACT_ID,
    "--source",
    process.env.ORACLE_HOT_WALLET_SECRET,
    "--rpc-url",
    process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org",
    "--network-passphrase",
    process.env.NETWORK_PASSPHRASE || "Test SDF Network ; September 2015",
    "--",
    "submit_outcome",
    "--market_id",
    marketId,
    "--outcome",
    String(outcome),
    "--bond",
    String(process.env.ORACLE_BOND_AMOUNT),
  ]);
}

/**
 * Claim an expired open market, determine its outcome, and submit it on-chain.
 * The market is released back to `open` on any failure so it is retried on the
 * next poll; nothing is submitted when external data cannot be fetched.
 *
 * @param {{ query: Function }} db
 * @param {{ id: string, category: string, params: object }} market
 * @param {{ determine?: Function, submit?: Function }} [deps]
 * @returns {Promise<boolean>} true when an outcome was submitted
 */
export async function submitExpiredMarket(db, market, deps = {}) {
  const determine = deps.determine ?? determineOutcome;
  const submit = deps.submit ?? submitOutcomeOnChain;

  const claim = await db.query(
    "UPDATE markets SET status = 'submitting' WHERE id = $1 AND status = 'open' RETURNING id",
    [market.id],
  );
  if (claim.rowCount === 0) {
    return false;
  }

  try {
    const outcome = await determine(market);
    await submit(market.id, outcome);
    await db.query("UPDATE markets SET status = 'submitted' WHERE id = $1", [
      market.id,
    ]);
    return true;
  } catch (err) {
    await db.query("UPDATE markets SET status = 'open' WHERE id = $1", [
      market.id,
    ]);
    console.error(
      `[auto-submitter] market ${market.id} not submitted: ${err.message}`,
    );
    return false;
  }
}
