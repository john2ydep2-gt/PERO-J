#!/usr/bin/env -S npx tsx
/**
 * PERO-J automated secret rotation.
 *
 * Zero-downtime rotation for:
 *   • PostgreSQL credentials  — dual-user ("blue/green") rotation
 *   • Admin API key           — two-phase rotation with an overlap window
 *   • Hot wallet signing key  — add-new-signer → deploy → remove-old-signer
 *
 * See docs/SECRET-ROTATION.md for the full runbook.
 *
 * Usage:
 *   npx tsx backend/scripts/rotate-secrets.ts <command> [options]
 *
 * Commands:
 *   setup-db            Idempotently create the owner role + both login users
 *   db                  Rotate the database password using the standby user
 *   api-key             Phase 1: issue a new admin API key, keep the old one valid
 *   api-key:finalize    Phase 2: revoke the previous admin API key
 *   hot-wallet          Phase 1: add a new signer to the hot wallet account
 *   hot-wallet:finalize Phase 2: remove the old signer from the hot wallet account
 *   status              Show which credentials are active (never prints secrets)
 *
 * Options:
 *   --backend <k8s|env-file>    Where secrets live (default: $SECRET_BACKEND or k8s)
 *   --namespace <ns>            Kubernetes namespace (default: $K8S_NAMESPACE or default)
 *   --secret <name>             Kubernetes Secret name (default: pero-secrets)
 *   --env-file <path>           .env file for the env-file backend (default: .env)
 *   --deployments <a,b>         Deployments to roll after updating (default: pero-indexer)
 *   --drain-timeout <seconds>   How long to wait for old DB sessions to drain (default: 300)
 *   --overlap <seconds>         For api-key: auto-finalize after this many seconds
 *   --dry-run                   Print the plan without changing anything
 *   --reveal                    Print newly generated API keys to stdout
 *
 * Environment:
 *   DB_ADMIN_URL         Connection string for a role with CREATEROLE (required for db commands)
 *   DB_APP_USERS         Comma-separated pair of login users (default: peroj_app_blue,peroj_app_green)
 *   DB_OWNER_ROLE        NOLOGIN role that owns the schema (default: peroj_app)
 *   HORIZON_URL          Horizon endpoint for hot-wallet rotation
 *   NETWORK_PASSPHRASE   Stellar network passphrase for hot-wallet rotation
 */

import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, rename, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);

// ─── Types ──────────────────────────────────────────────────────────────────

type SecretMap = Record<string, string>;

interface SecretStore {
  readonly name: string;
  read(): Promise<SecretMap>;
  /** Apply changes; `null` deletes the key. */
  write(changes: Record<string, string | null>): Promise<void>;
}

interface Restarter {
  restart(): Promise<void>;
}

interface Options {
  command: string;
  backend: "k8s" | "env-file";
  namespace: string;
  secret: string;
  envFile: string;
  deployments: string[];
  drainTimeoutS: number;
  overlapS: number | null;
  dryRun: boolean;
  reveal: boolean;
}

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

// ─── Utilities ──────────────────────────────────────────────────────────────

const log: Logger = {
  info: (m) => console.log(`[rotate] ${new Date().toISOString()} ${m}`),
  warn: (m) => console.warn(`[rotate] ${new Date().toISOString()} WARN ${m}`),
  error: (m) => console.error(`[rotate] ${new Date().toISOString()} ERROR ${m}`),
};

/** URL-safe random secret. 32 bytes ≈ 256 bits of entropy. */
export function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Mask a secret for logs: keeps 4 trailing chars. */
export function mask(value: string | undefined | null): string {
  if (!value) return "<unset>";
  return value.length <= 8 ? "****" : `****${value.slice(-4)}`;
}

/** Redact the password component of a Postgres URL. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "****";
    return u.toString();
  } catch {
    return "<invalid url>";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Options {
  const [command = "", ...rest] = argv;
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      i++;
    } else {
      flags.set(key, true);
    }
  }
  const str = (k: string, fallback: string) => (typeof flags.get(k) === "string" ? (flags.get(k) as string) : fallback);
  const backend = str("backend", env.SECRET_BACKEND || "k8s");
  if (backend !== "k8s" && backend !== "env-file") throw new Error(`Unknown --backend ${backend}`);
  const overlap = flags.get("overlap");
  return {
    command,
    backend,
    namespace: str("namespace", env.K8S_NAMESPACE || "default"),
    secret: str("secret", env.K8S_SECRET_NAME || "pero-secrets"),
    envFile: str("env-file", ".env"),
    deployments: str("deployments", env.ROTATE_DEPLOYMENTS || "pero-indexer")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    drainTimeoutS: Number(str("drain-timeout", "300")),
    overlapS: typeof overlap === "string" ? Number(overlap) : null,
    dryRun: flags.has("dry-run"),
    reveal: flags.has("reveal"),
  };
}

// ─── Secret stores ──────────────────────────────────────────────────────────

/** Kubernetes Secret backend (uses kubectl so no extra client libraries are needed). */
export class KubernetesSecretStore implements SecretStore {
  readonly name: string;
  private namespace: string;
  private secret: string;

  constructor(namespace: string, secret: string) {
    this.namespace = namespace;
    this.secret = secret;
    this.name = `k8s secret ${namespace}/${secret}`;
  }

  async read(): Promise<SecretMap> {
    const { stdout } = await exec("kubectl", ["-n", this.namespace, "get", "secret", this.secret, "-o", "json"]);
    const data: Record<string, string> = JSON.parse(stdout).data ?? {};
    return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Buffer.from(v, "base64").toString("utf8")]));
  }

  async write(changes: Record<string, string | null>): Promise<void> {
    const data: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(changes)) data[k] = v === null ? null : Buffer.from(v, "utf8").toString("base64");
    // JSON merge patch: null removes the key. Written to a 0600 temp file so secret
    // values never appear in the process list.
    const dir = await mkdtemp(join(tmpdir(), "rotate-"));
    const patchFile = join(dir, "patch.json");
    try {
      await writeFile(patchFile, JSON.stringify({ data }), { mode: 0o600 });
      await exec("kubectl", ["-n", this.namespace, "patch", "secret", this.secret, "--type=merge", "--patch-file", patchFile]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** .env file backend for docker-compose / single-host deployments. Writes atomically. */
export class EnvFileSecretStore implements SecretStore {
  readonly name: string;
  private path: string;

  constructor(path: string) {
    this.path = path;
    this.name = `env file ${path}`;
  }

  async read(): Promise<SecretMap> {
    const text = await readFile(this.path, "utf8").catch((e) => (e.code === "ENOENT" ? "" : Promise.reject(e)));
    const out: SecretMap = {};
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
    return out;
  }

  async write(changes: Record<string, string | null>): Promise<void> {
    const text = await readFile(this.path, "utf8").catch((e) => (e.code === "ENOENT" ? "" : Promise.reject(e)));
    const remaining = new Map(Object.entries(changes));
    const lines = text.split(/\r?\n/).flatMap((line) => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (!m || !remaining.has(m[1])) return [line];
      const value = remaining.get(m[1]);
      remaining.delete(m[1]);
      return value === null ? [] : [`${m[1]}=${value}`];
    });
    for (const [k, v] of remaining) if (v !== null) lines.push(`${k}=${v}`);
    const tmp = `${this.path}.rotate-${process.pid}`;
    await writeFile(tmp, lines.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
    await rename(tmp, this.path);
  }
}

// ─── Restarters ─────────────────────────────────────────────────────────────

/** Rolling restart: Kubernetes keeps old pods serving until new pods pass readiness. */
export class KubernetesRestarter implements Restarter {
  private namespace: string;
  private deployments: string[];

  constructor(namespace: string, deployments: string[]) {
    this.namespace = namespace;
    this.deployments = deployments;
  }

  async restart(): Promise<void> {
    for (const d of this.deployments) {
      log.info(`rolling restart deployment/${d}`);
      await exec("kubectl", ["-n", this.namespace, "rollout", "restart", `deployment/${d}`]);
    }
    for (const d of this.deployments) {
      await exec("kubectl", ["-n", this.namespace, "rollout", "status", `deployment/${d}`, "--timeout=600s"]);
      log.info(`deployment/${d} rolled out successfully`);
    }
  }
}

/** docker compose: recreate services one at a time. */
export class ComposeRestarter implements Restarter {
  private services: string[];

  constructor(services: string[]) {
    this.services = services.map((s) => s.replace(/^pero-/, ""));
  }

  async restart(): Promise<void> {
    for (const s of this.services) {
      log.info(`recreating compose service ${s}`);
      await exec("docker", ["compose", "up", "-d", "--no-deps", "--force-recreate", "--wait", s]);
    }
  }
}

// ─── PostgreSQL dual-user rotation ──────────────────────────────────────────

type PgClient = {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
  end(): Promise<void>;
  escapeLiteral(s: string): string;
  escapeIdentifier(s: string): string;
};

async function pgClient(connectionString: string): Promise<PgClient> {
  // Loaded lazily so the API-key / hot-wallet commands don't require `pg`.
  const pg: any = await import("pg");
  const Client = pg.default?.Client ?? pg.Client;
  const client: PgClient = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
  await client.connect();
  return client;
}

export function dbUsers(env: NodeJS.ProcessEnv = process.env): [string, string] {
  const users = (env.DB_APP_USERS || "peroj_app_blue,peroj_app_green").split(",").map((s) => s.trim()).filter(Boolean);
  if (users.length !== 2 || users[0] === users[1]) throw new Error("DB_APP_USERS must list exactly two distinct users");
  return [users[0], users[1]];
}

/** Given the active user, return the standby user that will receive the new password. */
export function standbyUser(active: string, users: [string, string]): string {
  if (active === users[0]) return users[1];
  if (active === users[1]) return users[0];
  // Active user is not one of the pair (first rotation after migrating) → start with the first.
  return users[0];
}

export function withCredentials(databaseUrl: string, user: string, password: string): string {
  const u = new URL(databaseUrl);
  u.username = encodeURIComponent(user);
  u.password = encodeURIComponent(password);
  return u.toString();
}

function requireAdminUrl(): string {
  const url = process.env.DB_ADMIN_URL;
  if (!url) throw new Error("DB_ADMIN_URL is required (a role with CREATEROLE privilege)");
  return url;
}

async function setupDb(opts: Options): Promise<void> {
  const users = dbUsers();
  const owner = process.env.DB_OWNER_ROLE || "peroj_app";
  log.info(`ensuring owner role "${owner}" and login users ${users.join(", ")}`);
  if (opts.dryRun) return;

  const admin = await pgClient(requireAdminUrl());
  try {
    const ownerId = admin.escapeIdentifier(owner);
    await admin.query(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${admin.escapeLiteral(owner)}) THEN
           CREATE ROLE ${ownerId} NOLOGIN;
         END IF;
       END $$;`
    );
    for (const user of users) {
      const id = admin.escapeIdentifier(user);
      await admin.query(
        `DO $$ BEGIN
           IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${admin.escapeLiteral(user)}) THEN
             CREATE ROLE ${id} LOGIN INHERIT;
           END IF;
         END $$;`
      );
      await admin.query(`GRANT ${ownerId} TO ${id}`);
      // Objects created by either user are owned by the shared role so both can use them.
      await admin.query(`ALTER ROLE ${id} SET role = ${admin.escapeLiteral(owner)}`);
    }
    const { rows } = await admin.query("SELECT current_database() AS db");
    const dbId = admin.escapeIdentifier(rows[0].db);
    await admin.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${dbId} TO ${ownerId}`);
    await admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${ownerId}`);
    log.info("setup complete. Transfer ownership of existing tables with:");
    log.info(`  REASSIGN OWNED BY <current_app_user> TO ${owner};`);
  } finally {
    await admin.end();
  }
}

async function waitForDrain(admin: PgClient, user: string, timeoutS: number): Promise<boolean> {
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    const { rows } = await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1", [user]);
    if (rows[0].n === 0) return true;
    log.info(`waiting for ${rows[0].n} session(s) of "${user}" to drain…`);
    await sleep(5_000);
  }
  return false;
}

async function rotateDb(opts: Options, store: SecretStore, restarter: Restarter): Promise<void> {
  const users = dbUsers();
  const secrets = await store.read();
  const currentUrl = secrets.DATABASE_URL;
  if (!currentUrl) throw new Error(`DATABASE_URL not found in ${store.name}`);

  const activeUser = decodeURIComponent(new URL(currentUrl).username);
  const nextUser = standbyUser(activeUser, users);
  const password = generateSecret(24);
  const nextUrl = withCredentials(currentUrl, nextUser, password);

  log.info(`active user: ${activeUser} → standby user: ${nextUser}`);
  log.info(`new DATABASE_URL: ${redactUrl(nextUrl)}`);
  if (opts.dryRun) {
    log.info("[dry-run] would: set standby password → verify login → update secret → rolling restart → drain → lock old user");
    return;
  }

  const admin = await pgClient(requireAdminUrl());
  try {
    // 1. Give the standby user a fresh password. The active user is untouched, so
    //    running pods keep working throughout.
    await admin.query(
      `ALTER ROLE ${admin.escapeIdentifier(nextUser)} WITH LOGIN PASSWORD ${admin.escapeLiteral(password)} VALID UNTIL 'infinity'`
    );
    log.info(`password set for standby user "${nextUser}"`);

    // 2. Verify the new credentials before anything depends on them.
    const probe = await pgClient(nextUrl);
    try {
      const { rows } = await probe.query("SELECT current_user AS u, 1 AS ok");
      if (rows[0]?.ok !== 1) throw new Error("verification query failed");
      log.info(`verified login as "${rows[0].u}"`);
    } finally {
      await probe.end();
    }

    // 3. Publish the new credentials and roll the application.
    await store.write({ DATABASE_URL: nextUrl, DATABASE_URL_PREVIOUS_USER: activeUser });
    log.info(`updated DATABASE_URL in ${store.name}`);
    try {
      await restarter.restart();
    } catch (err) {
      log.error(`rollout failed: ${(err as Error).message}. Restoring previous DATABASE_URL.`);
      await store.write({ DATABASE_URL: currentUrl, DATABASE_URL_PREVIOUS_USER: null });
      await restarter.restart().catch((e) => log.error(`rollback restart failed: ${(e as Error).message}`));
      throw err;
    }

    // 4. Once old pods are gone, lock the previous user so its password is useless.
    if (activeUser === nextUser || !users.includes(activeUser)) {
      log.warn(`previous user "${activeUser}" is outside the rotation pair; leaving it untouched. Revoke it manually once verified.`);
      return;
    }
    const drained = await waitForDrain(admin, activeUser, opts.drainTimeoutS);
    if (drained) {
      await admin.query(`ALTER ROLE ${admin.escapeIdentifier(activeUser)} WITH NOLOGIN PASSWORD NULL`);
      log.info(`locked previous user "${activeUser}" (NOLOGIN)`);
    } else {
      await admin.query(
        `ALTER ROLE ${admin.escapeIdentifier(activeUser)} VALID UNTIL ${admin.escapeLiteral(new Date(Date.now() + 3600_000).toISOString())}`
      );
      log.warn(`"${activeUser}" still has sessions after ${opts.drainTimeoutS}s; password expires in 1h. Investigate lingering clients.`);
    }
    log.info("database credential rotation complete ✔");
  } finally {
    await admin.end();
  }
}

// ─── Admin API key (two-phase) ──────────────────────────────────────────────

async function rotateApiKey(opts: Options, store: SecretStore, restarter: Restarter): Promise<void> {
  const secrets = await store.read();
  if (secrets.API_ADMIN_KEY_PREVIOUS) {
    throw new Error("API_ADMIN_KEY_PREVIOUS is still set — run `api-key:finalize` before starting a new rotation");
  }
  const oldKey = secrets.API_ADMIN_KEY;
  const newKey = generateSecret(32);
  log.info(`API_ADMIN_KEY ${mask(oldKey)} → ${mask(newKey)} (old key stays valid as API_ADMIN_KEY_PREVIOUS)`);
  if (opts.dryRun) return;

  const changes: Record<string, string | null> = { API_ADMIN_KEY: newKey };
  if (oldKey) changes.API_ADMIN_KEY_PREVIOUS = oldKey;
  await store.write(changes);
  await restarter.restart();
  if (opts.reveal) console.log(`NEW_API_ADMIN_KEY=${newKey}`);
  else log.info("new key stored; re-run with --reveal or read it from the secret store to distribute to clients");

  if (opts.overlapS !== null && oldKey) {
    log.info(`overlap window: waiting ${opts.overlapS}s before revoking the previous key`);
    await sleep(opts.overlapS * 1000);
    await finalizeApiKey(opts, store, restarter);
  } else if (oldKey) {
    log.info("phase 1 complete. Update clients, then run `api-key:finalize` to revoke the old key.");
  }
}

async function finalizeApiKey(opts: Options, store: SecretStore, restarter: Restarter): Promise<void> {
  const secrets = await store.read();
  if (!secrets.API_ADMIN_KEY_PREVIOUS) {
    log.info("no previous API key to revoke");
    return;
  }
  log.info(`revoking previous API key ${mask(secrets.API_ADMIN_KEY_PREVIOUS)}`);
  if (opts.dryRun) return;
  await store.write({ API_ADMIN_KEY_PREVIOUS: null });
  await restarter.restart();
  log.info("admin API key rotation complete ✔");
}

// ─── Hot wallet signer rotation ─────────────────────────────────────────────

async function stellar() {
  const sdk: any = await import("@stellar/stellar-sdk");
  const horizonUrl = process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";
  const passphrase = process.env.NETWORK_PASSPHRASE || sdk.Networks.TESTNET;
  const server = new sdk.Horizon.Server(horizonUrl);
  return { sdk, server, passphrase };
}

async function submitSetOptions(signerSecret: string, accountId: string, ops: any[]): Promise<string> {
  const { sdk, server, passphrase } = await stellar();
  const account = await server.loadAccount(accountId);
  const builder = new sdk.TransactionBuilder(account, { fee: String(Number(sdk.BASE_FEE) * 10), networkPassphrase: passphrase });
  for (const op of ops) builder.addOperation(op);
  const tx = builder.setTimeout(120).build();
  tx.sign(sdk.Keypair.fromSecret(signerSecret));
  const res = await server.submitTransaction(tx);
  return res.hash;
}

async function rotateHotWallet(opts: Options, store: SecretStore, restarter: Restarter): Promise<void> {
  const { sdk, server } = await stellar();
  const secrets = await store.read();
  const oldSecret = secrets.HOT_WALLET_SECRET;
  if (!oldSecret) throw new Error(`HOT_WALLET_SECRET not found in ${store.name}`);
  if (secrets.HOT_WALLET_SECRET_PREVIOUS) throw new Error("a hot-wallet rotation is in progress — run `hot-wallet:finalize` first");

  const oldKp = sdk.Keypair.fromSecret(oldSecret);
  const accountId = secrets.HOT_WALLET_ADDRESS || oldKp.publicKey();
  const account = await server.loadAccount(accountId);
  const oldSigner = account.signers.find((s: any) => s.key === oldKp.publicKey());
  if (!oldSigner) throw new Error(`current key ${oldKp.publicKey()} is not a signer on ${accountId}`);

  const newKp = sdk.Keypair.random();
  log.info(`hot wallet ${accountId}: adding signer ${newKp.publicKey()} (weight ${oldSigner.weight})`);
  if (opts.dryRun) return;

  // 1. Add the new key as a signer with the same weight → both keys can sign.
  const hash = await submitSetOptions(oldSecret, accountId, [
    sdk.Operation.setOptions({ signer: { ed25519PublicKey: newKp.publicKey(), weight: oldSigner.weight } }),
  ]);
  log.info(`signer added in tx ${hash}`);

  // 2. Publish the new key; services keep using HOT_WALLET_ADDRESS as the source account.
  await store.write({
    HOT_WALLET_SECRET: newKp.secret(),
    HOT_WALLET_SECRET_PREVIOUS: oldSecret,
    HOT_WALLET_ADDRESS: accountId,
  });
  await restarter.restart();
  log.info("phase 1 complete. Verify transactions are signed by the new key, then run `hot-wallet:finalize`.");
}

async function finalizeHotWallet(opts: Options, store: SecretStore, restarter: Restarter): Promise<void> {
  const { sdk } = await stellar();
  const secrets = await store.read();
  const prev = secrets.HOT_WALLET_SECRET_PREVIOUS;
  if (!prev) {
    log.info("no previous hot wallet key to remove");
    return;
  }
  const accountId = secrets.HOT_WALLET_ADDRESS;
  const prevKp = sdk.Keypair.fromSecret(prev);
  log.info(`removing signer ${prevKp.publicKey()} from ${accountId}`);
  if (opts.dryRun) return;

  // Master key → set master weight to 0; additional signer → weight 0 removes it.
  const op =
    prevKp.publicKey() === accountId
      ? sdk.Operation.setOptions({ masterWeight: 0 })
      : sdk.Operation.setOptions({ signer: { ed25519PublicKey: prevKp.publicKey(), weight: 0 } });
  const hash = await submitSetOptions(secrets.HOT_WALLET_SECRET, accountId, [op]);
  log.info(`old signer removed in tx ${hash}`);
  await store.write({ HOT_WALLET_SECRET_PREVIOUS: null });
  await restarter.restart();
  log.info("hot wallet key rotation complete ✔");
}

// ─── Status ─────────────────────────────────────────────────────────────────

async function status(store: SecretStore): Promise<void> {
  const s = await store.read();
  const dbUser = s.DATABASE_URL ? decodeURIComponent(new URL(s.DATABASE_URL).username) : "<unset>";
  console.table({
    backend: { value: store.name },
    "database user": { value: dbUser },
    "admin api key": { value: mask(s.API_ADMIN_KEY) },
    "admin api key (previous)": { value: mask(s.API_ADMIN_KEY_PREVIOUS) },
    "hot wallet address": { value: s.HOT_WALLET_ADDRESS || "<unset>" },
    "hot wallet rotation pending": { value: s.HOT_WALLET_SECRET_PREVIOUS ? "yes" : "no" },
  });
}

// ─── Entrypoint ─────────────────────────────────────────────────────────────

const USAGE = "usage: rotate-secrets.ts <setup-db|db|api-key|api-key:finalize|hot-wallet|hot-wallet:finalize|status> [options]";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const opts = parseArgs(argv);
  const store: SecretStore =
    opts.backend === "k8s" ? new KubernetesSecretStore(opts.namespace, opts.secret) : new EnvFileSecretStore(opts.envFile);
  const restarter: Restarter =
    opts.backend === "k8s" ? new KubernetesRestarter(opts.namespace, opts.deployments) : new ComposeRestarter(opts.deployments);

  if (opts.dryRun) log.info("DRY RUN — no changes will be made");

  switch (opts.command) {
    case "setup-db":
      return setupDb(opts);
    case "db":
      return rotateDb(opts, store, restarter);
    case "api-key":
      return rotateApiKey(opts, store, restarter);
    case "api-key:finalize":
      return finalizeApiKey(opts, store, restarter);
    case "hot-wallet":
      return rotateHotWallet(opts, store, restarter);
    case "hot-wallet:finalize":
      return finalizeHotWallet(opts, store, restarter);
    case "status":
      return status(store);
    default:
      throw new Error(USAGE);
  }
}

const invokedDirectly = process.argv[1] && /rotate-secrets\.(ts|js|mjs)$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    log.error((err as Error).message);
    process.exit(1);
  });
}
