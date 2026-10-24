import dotenv from "dotenv";
import { SorobanRpc } from "@stellar/stellar-sdk";
import { db } from "./db.js";
import { registerFixtures } from "./registerFixtures.js";
import { validateNetwork } from "./validateNetwork.js";
import { indexLedger } from "./index.js";

dotenv.config();

const RPC_URL = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";

function parseLedger(value, option) {
  const ledger = Number(value);
  if (!Number.isSafeInteger(ledger) || ledger < 1) {
    throw new Error(`${option} must be a positive safe integer`);
  }
  return ledger;
}

export function parseBackfillArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const [name, inlineValue] = args[index].split("=", 2);
    if (name !== "--from-ledger" && name !== "--to-ledger") {
      throw new Error(`Unknown option: ${name}`);
    }
    const value = inlineValue ?? args[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${name}`);
    }
    if (Object.hasOwn(options, name)) {
      throw new Error(`Duplicate option: ${name}`);
    }
    options[name] = parseLedger(value, name);
  }

  if (!options["--from-ledger"]) {
    throw new Error("Usage: node src/backfill.js --from-ledger <ledger> [--to-ledger <ledger>]");
  }
  if (options["--to-ledger"] && options["--to-ledger"] < options["--from-ledger"]) {
    throw new Error("--to-ledger must be greater than or equal to --from-ledger");
  }

  return { fromLedger: options["--from-ledger"], toLedger: options["--to-ledger"] ?? null };
}

function renderProgress(completed, total, ledger) {
  const width = 24;
  const filled = Math.floor((completed / total) * width);
  const bar = `${"#".repeat(filled)}${"-".repeat(width - filled)}`;
  process.stderr.write(`\rBackfill [${bar}] ${completed}/${total} ledgers (ledger ${ledger})`);
  if (completed === total) {
    process.stderr.write("\n");
  }
}

export async function runBackfill({ fromLedger, toLedger, rpcClient, database = db }) {
  const client = rpcClient ?? new SorobanRpc.Server(RPC_URL, { allowHttp: true });
  await database.init();
  try {
    await registerFixtures().catch((err) => {
      console.error("[fixtures] failed to register ABI fixtures:", err.message);
    });
    await validateNetwork(client);

    const lastLedger = toLedger ?? (await client.getLatestLedger()).sequence;
    if (lastLedger < fromLedger) {
      throw new Error("--to-ledger must be greater than or equal to --from-ledger");
    }

    const checkpoint = await database.getBackfillCheckpoint(fromLedger);
    const firstLedger = Math.max(fromLedger, (checkpoint ?? fromLedger - 1) + 1);
    const total = lastLedger - fromLedger + 1;
    if (firstLedger > lastLedger) {
      renderProgress(total, total, lastLedger);
      return;
    }

    for (let ledger = firstLedger; ledger <= lastLedger; ledger++) {
      await indexLedger(ledger, client, { onlyLedger: ledger, submitOnchain: false });
      await database.setBackfillCheckpoint(fromLedger, ledger);
      renderProgress(ledger - fromLedger + 1, total, ledger);
    }
  } finally {
    await database.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runBackfill(parseBackfillArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(`[backfill] ${err.message}`);
    process.exitCode = 1;
  }
}
