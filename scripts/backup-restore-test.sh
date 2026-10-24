#!/usr/bin/env bash
#
# Backup restore verification test.
#
# Restores the most recent local dump (or a specific DUMP_FILE path) into a
# temporary database, verifies row counts for key tables, and drops the test
# database on exit.
#
# Usage:
#   ./scripts/backup-restore-test.sh                # auto-finds newest dump
#   DUMP_FILE=./backups/my.dump ./scripts/backup-restore-test.sh
#
# Environment variables (same connection vars as backup.sh):
#   PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE
#   DATABASE_URL  — parsed when individual PG* vars are unset
#   DUMP_FILE     — path to the dump to restore (default: newest in BACKUP_DIR)
#   BACKUP_DIR    — directory containing dumps (default: ./backups)
#   TEST_DB       — name of the temporary restore target (default: <PGDATABASE>_restore_test)
#
# RPO / RTO targets (see docs/backup.md):
#   RPO ≤ 24 h with nightly base backups; ≤ 5 min with WAL archiving enabled.
#   RTO ≤ 1 h for a full restore on typical indexer database sizes (< 50 GB).
#
# Exit codes:
#   0 — restore succeeded and all checks passed
#   1 — prerequisite missing, restore failed, or row-count check failed

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"

# ── Derive connection settings ────────────────────────────────────────────────
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
TEST_DB="${TEST_DB:-${PGDATABASE}_restore_test}"

export PGHOST PGPORT PGUSER PGDATABASE
[[ -n "${PGPASSWORD:-}" ]] && export PGPASSWORD

# ── Prerequisite checks ───────────────────────────────────────────────────────
for cmd in pg_restore createdb dropdb psql; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: '$cmd' not found in PATH" >&2
    exit 1
  fi
done

# ── Locate dump file ──────────────────────────────────────────────────────────
if [[ -z "${DUMP_FILE:-}" ]]; then
  # Auto-select the newest dump in BACKUP_DIR.
  DUMP_FILE="$(ls -1t "${BACKUP_DIR}/${PGDATABASE}_"*.dump 2>/dev/null | head -n1 || true)"
  if [[ -z "$DUMP_FILE" ]]; then
    echo "ERROR: no dump files found in ${BACKUP_DIR}/ — run scripts/backup.sh first" >&2
    exit 1
  fi
fi

if [[ ! -f "$DUMP_FILE" ]]; then
  echo "ERROR: dump file not found: ${DUMP_FILE}" >&2
  exit 1
fi

echo "[restore-test] using dump: ${DUMP_FILE}"

# ── Cleanup trap ──────────────────────────────────────────────────────────────
cleanup() {
  echo "[restore-test] dropping test database ${TEST_DB} ..."
  dropdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --if-exists "$TEST_DB" 2>/dev/null || true
}
trap cleanup EXIT

# ── Create fresh test database ────────────────────────────────────────────────
echo "[restore-test] creating test database: ${TEST_DB}"
dropdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --if-exists "$TEST_DB"
createdb -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" "$TEST_DB"

# ── Restore ───────────────────────────────────────────────────────────────────
echo "[restore-test] restoring ..."
if ! pg_restore \
    -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" \
    -d "$TEST_DB" \
    --no-owner --no-privileges \
    --exit-on-error \
    "$DUMP_FILE"; then
  echo "ERROR: pg_restore failed" >&2
  exit 1
fi

echo "[restore-test] restore complete"

# ── Row-count sanity checks ───────────────────────────────────────────────────
# These checks confirm the schema and data were actually restored.
run_query() {
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$TEST_DB" \
    -tAc "$1" 2>/dev/null
}

echo "[restore-test] verifying tables ..."

EVENTS_COUNT="$(run_query "SELECT COUNT(*) FROM events;" 2>/dev/null || echo "MISSING")"
CONTRACTS_COUNT="$(run_query "SELECT COUNT(*) FROM contracts;" 2>/dev/null || echo "MISSING")"

if [[ "$EVENTS_COUNT" == "MISSING" ]]; then
  echo "ERROR: 'events' table is missing from the restored database" >&2
  exit 1
fi

if [[ "$CONTRACTS_COUNT" == "MISSING" ]]; then
  echo "ERROR: 'contracts' table is missing from the restored database" >&2
  exit 1
fi

echo "[restore-test] events table:    ${EVENTS_COUNT} rows"
echo "[restore-test] contracts table: ${CONTRACTS_COUNT} rows"

# Verify at least one sequence counter is sensible (non-negative integer).
if ! [[ "$EVENTS_COUNT" =~ ^[0-9]+$ ]]; then
  echo "ERROR: unexpected events count value: '${EVENTS_COUNT}'" >&2
  exit 1
fi

echo "[restore-test] PASS — restore verified successfully"
echo "[restore-test] RPO target: ≤ 24 h (nightly base backup) / ≤ 5 min (with WAL archiving)"
echo "[restore-test] RTO target: ≤ 1 h (typical indexer database < 50 GB)"
