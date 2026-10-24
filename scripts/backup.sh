#!/usr/bin/env bash
#
# Automated PostgreSQL backup using pg_dump.
#
# Produces a custom-format dump (-Fc), optionally uploads it to S3 using
# server-side AES-256 encryption (SSE-S3), and prunes old local dumps.
#
# Configurable via environment variables (see .env.example):
#   PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE
#   BACKUP_DIR       directory to write dumps into (default: ./backups)
#   RETENTION_DAYS   delete local dumps older than N days (default: 7)
#   BACKUP_S3_BUCKET S3 bucket name for remote upload (optional)
#   BACKUP_S3_PREFIX key prefix inside the bucket (default: postgres-backups)
#   BACKUP_S3_REGION AWS region (default: us-east-1)
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY — standard AWS env vars
#                    (or use an IAM instance role / profile)
#
# WAL archiving (point-in-time recovery) note:
#   Set archive_mode=on, archive_command in postgresql.conf, e.g.:
#     archive_command = 'aws s3 cp %p s3://$BACKUP_S3_BUCKET/wal/%f'
#   This base backup script complements WAL archiving; together they provide
#   RPO as low as the WAL shipping interval (~5 min on a busy testnet node).
#   See docs/backup.md for full PITR setup instructions.
#
# Cron (daily at 02:00 UTC):
#   0 2 * * * cd /path/to/repo && ./scripts/backup.sh >> /var/log/pg-backup.log 2>&1
#
# Restore procedure: see docs/backup.md

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:-}"
BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-postgres-backups}"
BACKUP_S3_REGION="${BACKUP_S3_REGION:-us-east-1}"
MIN_DUMP_BYTES=512

# Derive connection settings from DATABASE_URL when individual PG* vars are unset.
if [[ -n "${DATABASE_URL:-}" ]]; then
  : "${PGHOST:=$(printf '%s' "$DATABASE_URL" | sed -E 's#^[a-z]+://([^:@/]+)(:[^@/]*)?@([^:/]+)(:([0-9]+))?/([^?]+).*#\3#')}"
  : "${PGPORT:=$(printf '%s' "$DATABASE_URL" | sed -nE 's#^[a-z]+://([^:@/]+)(:[^@/]*)?@([^:/]+):([0-9]+)/([^?]+).*#\4#p')}"
  : "${PGUSER:=$(printf '%s' "$DATABASE_URL" | sed -E 's#^[a-z]+://([^:@/]+)(:[^@/]*)?@.*#\1#')}"
  : "${PGPASSWORD:=$(printf '%s' "$DATABASE_URL" | sed -nE 's#^[a-z]+://[^:@/]+:([^@/]*)@.*#\1#p')}"
  : "${PGDATABASE:=$(printf '%s' "$DATABASE_URL" | sed -E 's#^[a-z]+://[^?]*/([^?]+).*#\1#')}"
fi

: "${PGHOST:=localhost}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=soroban_explorer}"

export PGHOST PGPORT PGUSER PGDATABASE
[[ -n "${PGPASSWORD:-}" ]] && export PGPASSWORD

mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP_FILE="${BACKUP_DIR}/${PGDATABASE}_${TIMESTAMP}.dump"

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "ERROR: pg_dump not found in PATH" >&2
  exit 1
fi

echo "[backup] dumping ${PGDATABASE}@${PGHOST}:${PGPORT} -> ${DUMP_FILE}"

# Custom format (-Fc) supports selective restore via pg_restore.
if ! pg_dump -Fc -f "$DUMP_FILE"; then
  echo "ERROR: pg_dump failed" >&2
  rm -f "$DUMP_FILE"
  exit 1
fi

# Validate the dump is non-trivial (>512 bytes).
DUMP_SIZE="$(wc -c < "$DUMP_FILE" | tr -d ' ')"
if [[ "$DUMP_SIZE" -le "$MIN_DUMP_BYTES" ]]; then
  echo "ERROR: dump ${DUMP_FILE} is only ${DUMP_SIZE} bytes (expected > ${MIN_DUMP_BYTES})" >&2
  rm -f "$DUMP_FILE"
  exit 1
fi

echo "[backup] ok: ${DUMP_FILE} (${DUMP_SIZE} bytes)"

# ── Optional S3 upload with SSE-S3 server-side encryption ────────────────────
if [[ -n "$BACKUP_S3_BUCKET" ]]; then
  if ! command -v aws >/dev/null 2>&1; then
    echo "ERROR: aws CLI not found in PATH; cannot upload to S3" >&2
    exit 1
  fi

  S3_KEY="${BACKUP_S3_PREFIX}/${PGDATABASE}_${TIMESTAMP}.dump"
  S3_URI="s3://${BACKUP_S3_BUCKET}/${S3_KEY}"

  echo "[backup] uploading to ${S3_URI} (SSE-S3)"
  if ! aws s3 cp "$DUMP_FILE" "$S3_URI" \
       --region "$BACKUP_S3_REGION" \
       --sse aws:kms \
       --storage-class STANDARD_IA \
       --no-progress; then
    echo "ERROR: S3 upload failed" >&2
    # Keep the local dump so an operator can retry or recover manually.
    exit 1
  fi

  echo "[backup] S3 upload complete: ${S3_URI}"

  # Verify the object is reachable (ensures the upload is fully committed).
  if ! aws s3 ls "$S3_URI" --region "$BACKUP_S3_REGION" >/dev/null 2>&1; then
    echo "ERROR: S3 object not visible after upload — treating as upload failure" >&2
    exit 1
  fi

  echo "[backup] S3 object verified"
fi

# ── Prune old local dumps ─────────────────────────────────────────────────────
if [[ "$RETENTION_DAYS" -gt 0 ]]; then
  find "$BACKUP_DIR" -maxdepth 1 -name "${PGDATABASE}_*.dump" -type f \
    -mtime "+${RETENTION_DAYS}" -print -delete
fi

echo "[backup] done"
