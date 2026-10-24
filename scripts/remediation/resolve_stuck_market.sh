#!/usr/bin/env bash
# Trigger automated or emergency settlement for a stuck prediction market
set -euo pipefail

MARKET_ID="${1:-}"
OUTCOME_ID="${2:-}"
API_ADMIN_KEY="${API_ADMIN_KEY:-}"
INDEXER_URL="${INDEXER_URL:-http://localhost:3001}"

if [[ -z "${MARKET_ID}" ]]; then
  echo "Usage: $0 <MARKET_ID> [OUTCOME_ID]"
  echo "Example: $0 MKT-102 1"
  exit 1
fi

echo "[INFO] Querying status for market: ${MARKET_ID}..."
curl -s "${INDEXER_URL}/api/markets/${MARKET_ID}" || echo "[WARN] Failed to query market status."

if [[ -n "${OUTCOME_ID}" ]]; then
  echo "[INFO] Submitting emergency resolution for market ${MARKET_ID} with outcome ${OUTCOME_ID}..."
  curl -s -X POST "${INDEXER_URL}/api/admin/markets/${MARKET_ID}/resolve" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${API_ADMIN_KEY}" \
    -d "{\"outcome\": \"${OUTCOME_ID}\", \"force\": true}"
  echo ""
  echo "[SUCCESS] Resolution command dispatched."
else
  echo "[INFO] Forcing oracle feed poll retry for market ${MARKET_ID}..."
  curl -s -X POST "${INDEXER_URL}/api/admin/markets/${MARKET_ID}/poll-oracle" \
    -H "Authorization: Bearer ${API_ADMIN_KEY}"
  echo ""
  echo "[SUCCESS] Oracle re-poll dispatched."
fi
