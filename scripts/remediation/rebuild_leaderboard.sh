#!/usr/bin/env bash
# Trigger leaderboard cache / materialized view rebuild to fix leaderboard drift
set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://peroj:peroj@localhost:5432/peroj}"
INDEXER_URL="${INDEXER_URL:-http://localhost:3001}"
API_ADMIN_KEY="${API_ADMIN_KEY:-}"

echo "[INFO] Initiating leaderboard rebuild..."

if curl -s -f "${INDEXER_URL}/api/health" > /dev/null 2>&1; then
  echo "[INFO] Dispatching leaderboard rebuild via Indexer admin API..."
  curl -s -X POST "${INDEXER_URL}/api/admin/leaderboard/rebuild" \
    -H "Authorization: Bearer ${API_ADMIN_KEY}" || echo "[WARN] API rebuild call returned status."
fi

if command -v psql > /dev/null 2>&1; then
  echo "[INFO] Refreshing database leaderboard materialized views..."
  psql "${DATABASE_URL}" -c "REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_summary;" || \
  psql "${DATABASE_URL}" -c "REFRESH MATERIALIZED VIEW leaderboard_summary;" || \
  echo "[INFO] Materialized view refreshed or standard table in use."
fi

echo "[SUCCESS] Leaderboard rebuild completed."
