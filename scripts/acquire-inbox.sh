#!/usr/bin/env bash
# Tome Acquire — host inbox watcher (Seerr-shaped, no auto-download).
#
# Polls pending book_requests and writes acquire/INBOX.md when the queue
# changes. Optionally notifies Home Assistant if HA_TOKEN is set in .env.
#
# Install (on docker-vm):
#   chmod +x /home/chris/docker/tome/acquire/inbox.sh
#   crontab -e →
#     */15 * * * * /home/chris/docker/tome/acquire/inbox.sh >>/home/chris/docker/tome/acquire/cron.log 2>&1
#
# This script NEVER downloads copyrighted media. It only surfaces demand.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# When installed as acquire/inbox.sh, ROOT is ~/docker/tome
if [[ "$(basename "$(dirname "$0")")" == "acquire" ]]; then
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
elif [[ "$(basename "$(dirname "$0")")" == "scripts" ]]; then
  ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
fi

ENV_FILE="${TOME_ENV:-$ROOT/.env}"
STATE_DIR="$ROOT/acquire"
INBOX="$STATE_DIR/INBOX.md"
SEEN="$STATE_DIR/.seen_ids"
mkdir -p "$STATE_DIR"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${SUPABASE_URL:?}"
: "${SUPABASE_SERVICE_ROLE_KEY:?}"

RAW=$(curl -sS \
  "${SUPABASE_URL}/rest/v1/book_requests?status=eq.pending&select=id,title,authors,isbn_13,open_library_id,note,reason,requester_id,created_at&order=created_at.asc" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Accept: application/json")

export ACQUIRE_INBOX="$INBOX"
export ACQUIRE_SEEN="$SEEN"
export ACQUIRE_RAW="$RAW"

python3 <<'PY'
import json, os
from datetime import datetime, timezone

inbox_path = os.environ["ACQUIRE_INBOX"]
seen_path = os.environ["ACQUIRE_SEEN"]
rows = json.loads(os.environ["ACQUIRE_RAW"])
if not isinstance(rows, list):
    raise SystemExit(f"Unexpected response: {rows!r}")

seen = set()
if os.path.exists(seen_path):
    with open(seen_path) as f:
        seen = {line.strip() for line in f if line.strip()}

ids = [r["id"] for r in rows]
new_ids = [i for i in ids if i not in seen]

now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
lines = [
    "# Tome Acquire Inbox",
    "",
    f"_Updated {now}_",
    "",
    f"Pending: **{len(rows)}**",
    "",
]
if not rows:
    lines += ["Queue is empty. Nothing to acquire.", ""]
else:
    lines += [
        "| When | Title | Authors | Note |",
        "|---|---|---|---|",
    ]
    for r in rows:
        authors = ", ".join(r.get("authors") or []) or "—"
        note = (r.get("note") or "").replace("|", "/").replace("\n", " ")
        title = (r.get("title") or "?").replace("|", "/")
        when = (r.get("created_at") or "")[:16].replace("T", " ")
        lines.append(f"| {when} | {title} | {authors} | {note} |")
    lines += [
        "",
        "## Next steps",
        "1. Acquire via a source this household may use.",
        "2. Drop under `$LIBRARY_PATH/{kids|audiobooks|ebooks}/Author/Title/`.",
        "3. Scan: `cd ~/docker/tome && docker compose exec -T server wget -qO- --post-data='' http://127.0.0.1:3000/scan`",
        "   (or Scan now in the app).",
        "4. If unfindable: decline with a note from the app Inbox.",
        "",
        "See `docs/acquire.md`.",
        "",
    ]

with open(inbox_path, "w") as f:
    f.write("\n".join(lines) + "\n")

with open(seen_path, "w") as f:
    for i in ids:
        f.write(i + "\n")

print(f"[acquire] pending={len(rows)} new={len(new_ids)}")
signal = os.path.join(os.path.dirname(inbox_path), "NEW_REQUESTS")
if new_ids:
    with open(signal, "w") as f:
        f.write("\n".join(new_ids) + "\n")
    print(f"[acquire] NEW: {', '.join(new_ids)}")
    # Export for bash HA notify
    open(os.path.join(os.path.dirname(inbox_path), ".notify_flag"), "w").write(
        f"{len(new_ids)}\n{(rows[0].get('title') if rows else 'book')}\n"
    )
elif os.path.exists(signal) and not rows:
    os.remove(signal)
PY

if [[ -f "$STATE_DIR/.notify_flag" ]]; then
  COUNT=$(sed -n '1p' "$STATE_DIR/.notify_flag")
  TITLE=$(sed -n '2p' "$STATE_DIR/.notify_flag")
  rm -f "$STATE_DIR/.notify_flag"
  HA_URL="${HA_URL:-http://192.168.86.54:8123}"
  if [[ -n "${HA_TOKEN:-}" ]]; then
    curl -sS -X POST \
      -H "Authorization: Bearer $HA_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"message\":\"Tome: $COUNT new request(s) — $TITLE\",\"title\":\"Tome Acquire\"}" \
      "$HA_URL/api/services/persistent_notification/create" >/dev/null 2>&1 \
      || curl -sS -X POST \
        -H "Authorization: Bearer $HA_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"title\":\"Tome Acquire\",\"message\":\"$COUNT new — $TITLE\"}" \
        "$HA_URL/api/services/notify/notify" >/dev/null 2>&1 \
      || true
    echo "[acquire] HA notify attempted"
  fi
fi
