#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# PERO-J staging smoke test suite.
#
# Verifies the staging environment is up and the full request path works:
#   frontend (nginx) → /api/* → indexer → PostgreSQL (testnet-backed).
#
# Usage:
#   scripts/smoke-test.sh <base-url>
# Example:
#   scripts/smoke-test.sh http://localhost:8080
#
# Exits 0 if all checks pass, 1 otherwise.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BASE="${1:?usage: smoke-test.sh <base-url>}"
MAX_TIME=15
FAIL=0

pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1" >&2; FAIL=1; }

check_status() {
  local path="$1" expect="$2"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$MAX_TIME" "${BASE}${path}" || true)
  if [ "$code" = "$expect" ]; then
    pass "GET ${path} -> ${code}"
  else
    fail "GET ${path} -> ${code} (expected ${expect})"
  fi
}

echo "Smoke testing ${BASE}"

# ── 1. Frontend served ───────────────────────────────────────────────────────
if curl -s --max-time "$MAX_TIME" "${BASE}/" | grep -q '<div id="root">\|<title>'; then
  pass "frontend index.html served"
else
  fail "frontend index.html not served"
fi
check_status "/" 200

# ── 2. API reachable through the frontend proxy (nginx → indexer → db) ───────
check_status "/api/contracts" 200
check_status "/api/events" 200
check_status "/api/functions" 200

# ── 3. API response shapes ───────────────────────────────────────────────────
if body=$(curl -s --max-time "$MAX_TIME" "${BASE}/api/contracts"); then
  if echo "$body" | jq -e '.contracts | type == "array"' >/dev/null 2>&1 \
     && echo "$body" | jq -e '.total | type == "number"' >/dev/null 2>&1; then
    pass "/api/contracts returned { contracts: [], total: number }"
  else
    fail "/api/contracts response shape unexpected: $(echo "$body" | head -c 200)"
  fi
else
  fail "/api/contracts returned no body"
fi

if body=$(curl -s --max-time "$MAX_TIME" "${BASE}/api/events"); then
  if echo "$body" | jq -e '.events | type == "array"' >/dev/null 2>&1; then
    pass "/api/events returned { events: [] }"
  else
    fail "/api/events response shape unexpected: $(echo "$body" | head -c 200)"
  fi
else
  fail "/api/events returned no body"
fi

# ── 4. Health (indexer liveness) via /api route if exposed, else skip ─────────
# The indexer's /health is not under /api, so it is not reachable through the
# nginx /api proxy. We rely on the /api/* checks above to confirm indexer health.

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "All smoke tests passed."
  exit 0
else
  echo "Smoke tests FAILED." >&2
  exit 1
fi
