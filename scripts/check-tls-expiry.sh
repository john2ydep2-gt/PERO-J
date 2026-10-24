#!/usr/bin/env bash
# scripts/check-tls-expiry.sh
#
# Checks the TLS certificate expiry date for one or more HTTPS endpoints.
# Exits non-zero (and prints an error) if any certificate expires within
# WARN_DAYS (default 15) days.
#
# Usage:
#   ./scripts/check-tls-expiry.sh [HOST:PORT …]
#
# Environment variables:
#   WARN_DAYS          – days-remaining threshold before alerting (default: 15)
#   ALERT_WEBHOOK_URL  – optional Slack/Discord/generic webhook URL for alerts
#   NOTIFY_EMAIL       – optional e-mail address to receive alerts (requires
#                        the `mail` command to be available in PATH)
#
# Examples:
#   # Check two endpoints:
#   WARN_DAYS=30 ./scripts/check-tls-expiry.sh api.example.com:443 app.example.com:443
#
#   # Used by CI (reads HOSTS_TO_CHECK from the environment):
#   ./scripts/check-tls-expiry.sh

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
WARN_DAYS="${WARN_DAYS:-15}"
ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"
NOTIFY_EMAIL="${NOTIFY_EMAIL:-}"

# Hosts passed as arguments; fall back to HOSTS_TO_CHECK env var (space-separated).
if [ "$#" -gt 0 ]; then
  HOSTS=("$@")
else
  IFS=' ' read -r -a HOSTS <<< "${HOSTS_TO_CHECK:-}"
fi

if [ "${#HOSTS[@]}" -eq 0 ]; then
  echo "Usage: $0 HOST:PORT [HOST:PORT …]"
  echo "       or set HOSTS_TO_CHECK='host1:443 host2:443'"
  exit 1
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
send_alert() {
  local message="$1"

  echo "ALERT: $message" >&2

  if [ -n "$ALERT_WEBHOOK_URL" ]; then
    curl -s -X POST "$ALERT_WEBHOOK_URL" \
      -H 'Content-Type: application/json' \
      -d "{\"text\": \"🔐 TLS Expiry Alert: ${message}\"}" || true
  fi

  if [ -n "$NOTIFY_EMAIL" ] && command -v mail &>/dev/null; then
    echo "$message" | mail -s "TLS Certificate Expiry Warning" "$NOTIFY_EMAIL" || true
  fi
}

days_until_expiry() {
  # Returns the number of days until the certificate on HOST:PORT expires.
  # Prints a negative number if already expired.
  local host_port="$1"
  local host="${host_port%%:*}"
  local port="${host_port##*:}"

  local expiry_date
  expiry_date=$(echo \
    | openssl s_client -servername "$host" -connect "${host}:${port}" 2>/dev/null \
    | openssl x509 -noout -enddate 2>/dev/null \
    | sed 's/notAfter=//')

  if [ -z "$expiry_date" ]; then
    echo "-1"
    return
  fi

  local expiry_epoch now_epoch
  expiry_epoch=$(date -d "$expiry_date" +%s 2>/dev/null \
    || date -j -f "%b %d %T %Y %Z" "$expiry_date" +%s 2>/dev/null)
  now_epoch=$(date +%s)

  echo $(( (expiry_epoch - now_epoch) / 86400 ))
}

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
FAILED=0

for HOST_PORT in "${HOSTS[@]}"; do
  # Normalise: if no port given, default to 443
  if [[ "$HOST_PORT" != *:* ]]; then
    HOST_PORT="${HOST_PORT}:443"
  fi

  echo -n "Checking ${HOST_PORT} … "

  DAYS=$(days_until_expiry "$HOST_PORT")

  if [ "$DAYS" -lt 0 ]; then
    send_alert "Certificate for ${HOST_PORT} has ALREADY EXPIRED."
    FAILED=1
  elif [ "$DAYS" -lt "$WARN_DAYS" ]; then
    send_alert "Certificate for ${HOST_PORT} expires in ${DAYS} day(s) (threshold: ${WARN_DAYS})."
    FAILED=1
  else
    echo "OK – expires in ${DAYS} day(s)."
  fi
done

exit "$FAILED"
