import crypto from "node:crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { db } from "./db.js";

/**
 * Standard domain separator for PERO-J off-chain oracle payload signing.
 */
export const DOMAIN_SEPARATOR = "PERO-J_ORACLE_ATTESTATION_V1";

/**
 * Maximum acceptable timestamp age: 5 minutes in milliseconds.
 */
export const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000;

/**
 * Maximum acceptable future clock drift: 60 seconds in milliseconds.
 */
export const MAX_FUTURE_DRIFT_MS = 60 * 1000;

/**
 * Custom error class for Oracle payload verification and replay defense errors.
 */
export class OracleVerificationError extends Error {
  /**
   * @param {string} message
   * @param {number} statusCode
   * @param {string} code
   */
  constructor(message, statusCode = 400, code = "ORACLE_VERIFICATION_FAILED") {
    super(message);
    this.name = "OracleVerificationError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Deterministically constructs the canonical domain-separated message buffer
 * for cryptographic signing and verification.
 *
 * @param {object} payload
 * @param {string} payload.domain
 * @param {string} payload.chain_id
 * @param {string} payload.market_id
 * @param {string} payload.nonce
 * @param {number} payload.timestamp
 * @param {unknown} payload.outcome
 * @returns {Buffer}
 */
export function buildCanonicalAttestationMessage({
  domain,
  chain_id,
  market_id,
  nonce,
  timestamp,
  outcome,
}) {
  const normalized = {
    domain,
    chain_id,
    market_id,
    nonce: String(nonce),
    timestamp: Number(timestamp),
    outcome,
  };
  const serialized = JSON.stringify(normalized, Object.keys(normalized).sort());
  return crypto.createHash("sha256").update(serialized).digest();
}

/**
 * Validates the structure and cryptographic signature of an off-chain oracle signed payload,
 * enforcing:
 * 1. Domain separator equality
 * 2. Mandatory chain_id, market_id, and nonce
 * 3. Freshness window (< 5 minutes old, max 60s future drift)
 * 4. Replay attack rejection against database consumed nonces table
 * 5. Valid ed25519 signature
 *
 * @param {object} payload
 * @param {string} payload.domain
 * @param {string} payload.chain_id
 * @param {string} payload.market_id
 * @param {string} payload.nonce
 * @param {number} payload.timestamp - Epoch milliseconds
 * @param {unknown} payload.outcome
 * @param {string} payload.provider_id - Stellar G... public key or ed25519 pubkey
 * @param {string} payload.signature - Hex or Base64 encoded signature
 * @param {object} [options]
 * @param {number} [options.now] - Override current timestamp for testing
 * @returns {Promise<{ verified: boolean, message: string }>}
 */
export async function verifyAndConsumeOracleAttestation(payload, options = {}) {
  if (!payload || typeof payload !== "object") {
    throw new OracleVerificationError("Invalid payload: payload must be a non-null object", 400, "INVALID_PAYLOAD");
  }

  const {
    domain,
    chain_id,
    market_id,
    nonce,
    timestamp,
    outcome,
    provider_id,
    signature,
  } = payload;

  // 1. Domain separator validation
  if (!domain || domain !== DOMAIN_SEPARATOR) {
    throw new OracleVerificationError(
      `Invalid domain separator "${domain}". Expected "${DOMAIN_SEPARATOR}"`,
      400,
      "INVALID_DOMAIN_SEPARATOR"
    );
  }

  // 2. Validate mandatory fields
  if (!chain_id || typeof chain_id !== "string") {
    throw new OracleVerificationError("Missing or invalid field: chain_id", 400, "MISSING_CHAIN_ID");
  }
  if (!market_id || typeof market_id !== "string") {
    throw new OracleVerificationError("Missing or invalid field: market_id", 400, "MISSING_MARKET_ID");
  }
  if (!nonce || typeof nonce !== "string") {
    throw new OracleVerificationError("Missing or invalid field: nonce", 400, "MISSING_NONCE");
  }
  if (outcome === undefined || outcome === null) {
    throw new OracleVerificationError("Missing field: outcome", 400, "MISSING_OUTCOME");
  }
  if (!provider_id || typeof provider_id !== "string") {
    throw new OracleVerificationError("Missing or invalid field: provider_id", 400, "MISSING_PROVIDER_ID");
  }
  if (!signature || typeof signature !== "string") {
    throw new OracleVerificationError("Missing or invalid field: signature", 400, "MISSING_SIGNATURE");
  }

  // 3. Timestamp expiry validation (must not be older than 5 minutes)
  const now = options.now || Date.now();
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    throw new OracleVerificationError("Invalid timestamp: must be finite number", 400, "INVALID_TIMESTAMP");
  }

  const age = now - ts;
  if (age > MAX_TIMESTAMP_AGE_MS) {
    throw new OracleVerificationError(
      `Signature expired: payload timestamp is older than 5 minutes (${Math.round(age / 1000)}s old)`,
      400,
      "SIGNATURE_EXPIRED"
    );
  }

  if (ts - now > MAX_FUTURE_DRIFT_MS) {
    throw new OracleVerificationError(
      `Timestamp in future: payload timestamp exceeds allowable clock drift (${Math.round((ts - now) / 1000)}s ahead)`,
      400,
      "TIMESTAMP_IN_FUTURE"
    );
  }

  // 4. Replay attack verification: check database consumed nonces
  const alreadyConsumed = await db.isNonceConsumed(provider_id, nonce);
  if (alreadyConsumed) {
    throw new OracleVerificationError(
      `Replay attack detected: nonce "${nonce}" has already been consumed for provider "${provider_id}"`,
      409,
      "REPLAY_DETECTED"
    );
  }

  // 5. Cryptographic signature verification
  const canonicalHash = buildCanonicalAttestationMessage({
    domain,
    chain_id,
    market_id,
    nonce,
    timestamp: ts,
    outcome,
  });

  let signatureValid = false;
  try {
    const rawSig = Buffer.from(
      signature,
      signature.length === 128 ? "hex" : "base64"
    );

    if (StrKey.isValidEd25519PublicKey(provider_id)) {
      const keypair = Keypair.fromPublicKey(provider_id);
      signatureValid = keypair.verify(canonicalHash, rawSig);
    } else {
      // Direct raw public key verify fallback
      const pubBuf = Buffer.from(provider_id, "hex");
      signatureValid = crypto.verify(
        null,
        canonicalHash,
        {
          key: pubBuf,
          format: "der",
          type: "spki",
        },
        rawSig
      );
    }
  } catch (err) {
    throw new OracleVerificationError(
      `Cryptographic signature verification failed: ${err.message}`,
      401,
      "INVALID_SIGNATURE"
    );
  }

  if (!signatureValid) {
    throw new OracleVerificationError(
      "Cryptographic signature check failed: signature does not match canonical payload",
      401,
      "INVALID_SIGNATURE"
    );
  }

  // 6. Record nonce atomically in the database to prevent future replays
  try {
    await db.recordOracleNonce({
      provider_id,
      nonce,
      market_id,
      chain_id,
      timestamp: new Date(ts),
    });
  } catch (err) {
    if (err.code === "23505") {
      // Postgres unique violation
      throw new OracleVerificationError(
        `Replay attack detected: duplicate nonce concurrent insert for provider "${provider_id}"`,
        409,
        "REPLAY_DETECTED"
      );
    }
    throw err;
  }

  return {
    verified: true,
    message: "Oracle attestation verified and nonce consumed successfully",
  };
}
