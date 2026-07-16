#!/usr/bin/env bash
# List pending book_requests using the library server's .env service role.
# Run on the docker-vm host from ~/docker/tome (or any dir with .env):
#
#   cd ~/docker/tome && ./server/scripts/list-pending-via-service-role.sh
#
# This does NOT download books. Requesting in the app only queues a row;
# you (or an agent you invoke) still have to acquire the file + scan.

set -euo pipefail

ENV_FILE="${1:-.env}"
if [[ ! -f "$ENV_FILE" ]]; then
  # common layout: script lives in server/scripts, .env at compose root
  if [[ -f ../.env ]]; then ENV_FILE=../.env
  elif [[ -f ../../.env ]]; then ENV_FILE=../../.env
  else
    echo "No .env found (looked for $ENV_FILE). Pass path: $0 /path/to/.env" >&2
    exit 1
  fi
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ -z "${SUPABASE_URL:-}" || -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
  echo "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required in $ENV_FILE" >&2
  exit 1
fi

echo "=== Pending book requests (not auto-acquired) ==="
curl -sS "${SUPABASE_URL}/rest/v1/book_requests?status=eq.pending&select=id,title,authors,isbn_13,open_library_id,note,reason,requester_id,created_at&order=created_at.asc" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Accept: application/json" | python3 -m json.tool

echo
echo "Next steps:"
echo "  1. Acquire each title (legal source the household may use)."
echo "  2. Drop under \$LIBRARY_PATH (e.g. adult/Author/Title/book.m4b)."
echo "  3. docker compose exec server ... or POST /scan / app Scan now."
echo "  4. Auto-fulfill matches ISBN / Open Library id / title+author."
echo
echo "Nothing watches this queue automatically — request ≠ download."
