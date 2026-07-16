#!/usr/bin/env bash
# List pending book requests on the local Tome library server.
#
# Usage:
#   TOME_JWT=... ./scripts/pending-requests.sh
#   TOME_JWT=... ./scripts/pending-requests.sh decline <request-id> "reason"
#   TOME_JWT=... ./scripts/pending-requests.sh fulfill <request-id>
#   TOME_JWT=... ./scripts/pending-requests.sh scan
#
# Base URL defaults to http://localhost:3000 (override with TOME_URL).

set -euo pipefail

BASE="${TOME_URL:-http://localhost:3000}"
JWT="${TOME_JWT:-}"

if [[ -z "$JWT" ]]; then
  echo "Set TOME_JWT to a Supabase access token for the library owner or service user." >&2
  exit 1
fi

auth=(-H "Authorization: Bearer $JWT" -H "Content-Type: application/json")

cmd="${1:-list}"
case "$cmd" in
  list)
    curl -sS "${auth[@]}" "$BASE/api/v1/requests/pending" | (command -v jq >/dev/null && jq . || cat)
    ;;
  decline)
    id="${2:?request id required}"
    note="${3:-}"
    curl -sS -X POST "${auth[@]}" \
      -d "$(jq -n --arg n "$note" '{note: $n}')" \
      "$BASE/api/v1/requests/$id/decline" | (command -v jq >/dev/null && jq . || cat)
    ;;
  fulfill)
    id="${2:?request id required}"
    curl -sS -X POST "${auth[@]}" \
      "$BASE/api/v1/requests/$id/fulfill" | (command -v jq >/dev/null && jq . || cat)
    ;;
  scan)
    curl -sS -X POST "${auth[@]}" "$BASE/scan" | (command -v jq >/dev/null && jq . || cat)
    ;;
  *)
    echo "Usage: $0 [list|decline <id> [note]|fulfill <id>|scan]" >&2
    exit 1
    ;;
esac
