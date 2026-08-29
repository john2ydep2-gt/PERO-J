#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

BACKUP_DIR="${BACKUP_DIR:-${PROJECT_DIR}/backups}"
LOG_FILE="${LOG_FILE:-${PROJECT_DIR}/logs/backup.log}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/soroban_explorer_${TIMESTAMP}.sql"

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-user}"
PGDATABASE="${PGDATABASE:-soroban_explorer}"
PGPASSWORD="${PGPASSWORD:-}"

export PGPASSWORD

mkdir -p "${BACKUP_DIR}"
mkdir -p "$(dirname "${LOG_FILE}")"

echo "[$(date -Iseconds)] Starting backup of ${PGDATABASE} to ${BACKUP_FILE}" >> "${LOG_FILE}"

if pg_dump \
  --host="${PGHOST}" \
  --port="${PGPORT}" \
  --username="${PGUSER}" \
  --dbname="${PGDATABASE}" \
  --format=plain \
  --compress=0 \
  --no-owner \
  --no-privileges \
  --clean \
  --if-exists \
  --create \
  > "${BACKUP_FILE}" 2>> "${LOG_FILE}"; then
  if [ "$(stat -c%s "${BACKUP_FILE}")" -gt 512 ]; then
    echo "[$(date -Iseconds)] Backup completed successfully: ${BACKUP_FILE}" >> "${LOG_FILE}"
  else
    echo "[$(date -Iseconds)] Backup FAILED: dump file is too small (<= 512 bytes)" >> "${LOG_FILE}"
    rm -f "${BACKUP_FILE}"
    exit 1
  fi
else
  echo "[$(date -Iseconds)] Backup FAILED" >> "${LOG_FILE}"
  rm -f "${BACKUP_FILE}"
  exit 1
fi

find "${BACKUP_DIR}" -name 'soroban_explorer_*.sql' -mtime +30 -delete 2>> "${LOG_FILE}"

echo "[$(date -Iseconds)] Cleanup complete. Backups older than 30 days removed." >> "${LOG_FILE}"
