/**
 * Standalone schema-migration entrypoint.
 *
 * Runs `db.init()` (which applies all pending migrations under a Postgres
 * advisory lock) and exits. Used by:
 *   • `npm run migrate` (see package.json) — invoked by the Makefile `migrate` target.
 *   • the `migrate` one-shot service in docker-compose.yml, so the schema is
 *     pre-applied before the indexer/API starts serving traffic.
 *
 * Exits 0 on success, 1 on failure.
 */
import dotenv from "dotenv";
import { db } from "./db.js";

dotenv.config();

async function main() {
  console.log("[migrate] connecting and applying schema migrations…");
  await db.init();
  console.log("[migrate] migrations applied successfully.");
  await db.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
