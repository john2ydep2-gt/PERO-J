#!/usr/bin/env bash
# Failover to secondary or backup Stellar RPC provider
set -euo pipefail

NEW_RPC_URL="${1:-https://mainnet.sorobanrpc.com}"
CONTAINER_NAME="${CONTAINER_NAME:-peroj-indexer-1}"

echo "[INFO] Testing connectivity to target RPC provider: ${NEW_RPC_URL}..."
HEALTH_RESPONSE=$(curl -s -X POST "${NEW_RPC_URL}" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' || echo "")

if echo "${HEALTH_RESPONSE}" | grep -q '"status":"healthy"'; then
  echo "[SUCCESS] Target RPC provider reports healthy."
else
  echo "[WARN] Target RPC did not return healthy status. Response: ${HEALTH_RESPONSE}"
fi

echo "[INFO] Updating RPC_URL environment variable to ${NEW_RPC_URL}..."
if command -v docker > /dev/null 2>&1 && docker ps -q -f name="${CONTAINER_NAME}" | grep -q .; then
  echo "[INFO] Restarting docker container with updated RPC_URL..."
  docker exec "${CONTAINER_NAME}" sh -c "export RPC_URL='${NEW_RPC_URL}'" || true
  docker restart "${CONTAINER_NAME}"
fi

echo "[SUCCESS] RPC provider failover completed."
