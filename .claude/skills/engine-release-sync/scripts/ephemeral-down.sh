#!/bin/bash
# Stops what ephemeral-up.sh started: the engine process, its Postgres container
# and the engine worktree. Leaves WORKDIR's logs in place.
set -uo pipefail
WORKDIR=${WORKDIR:-${TMPDIR:-/tmp}/polyant-cli-sync}
[ -f "$WORKDIR/state.env" ] || { echo "nothing to stop in $WORKDIR" >&2; exit 0; }
. "$WORKDIR/state.env"
if [ -f "$WORKDIR/engine.pid" ]; then
  pkill -P "$(cat "$WORKDIR/engine.pid")" 2>/dev/null
  kill "$(cat "$WORKDIR/engine.pid")" 2>/dev/null
fi
# npx leaves the tsx child behind its own pid; the port names the survivor.
lsof -ti "tcp:$API_PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null
docker rm -f "$PG_NAME" >/dev/null 2>&1
git -C "$ENTERPRISE_DIR" worktree remove --force "$ENGINE" 2>/dev/null
rm -f "$WORKDIR/state.env" "$WORKDIR/engine.pid" "$WORKDIR"/*.tok
echo "stopped; logs kept in $WORKDIR" >&2
