#!/usr/bin/env bash
# Restart indexer service and verify recovery
set -euo pipefail

INDEXER_URL="${INDEXER_URL:-http://localhost:3001}"
CONTAINER_NAME="${CONTAINER_NAME:-peroj-indexer-1}"

echo "[INFO] Checking indexer health at ${INDEXER_URL}/api/health..."
if curl -s -f "${INDEXER_URL}/api/health" > /dev/null 2>&1; then
  echo "[INFO] Indexer is currently responding to health checks."
else
  echo "[WARN] Indexer is unresponsive or unhealthy."
fi

echo "[INFO] Restarting indexer container / process (${CONTAINER_NAME})..."
if command -v docker > /dev/null 2>&1 && docker ps -q -f name="${CONTAINER_NAME}" | grep -q .; then
  docker restart "${CONTAINER_NAME}"
elif command -v kubectl > /dev/null 2>&1 && kubectl get deployment indexer > /dev/null 2>&1; then
  kubectl rollout restart deployment/indexer
else
  echo "[WARN] Neither Docker container nor Kubernetes deployment found. Restarting local process..."
  pkill -f "node.*indexer" || true
  npm --prefix indexer start &
fi

echo "[INFO] Awaiting indexer health check recovery..."
for i in {1..30}; do
  if curl -s -f "${INDEXER_URL}/api/health" > /dev/null 2>&1; then
    echo "[SUCCESS] Indexer healthy and accepting connections."
    exit 0
  fi
  sleep 2
done

echo "[ERROR] Timed out waiting for indexer to report healthy."
exit 1
