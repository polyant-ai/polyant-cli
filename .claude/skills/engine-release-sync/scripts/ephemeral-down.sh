#!/bin/bash
# Stops what ephemeral-up.sh started: the engine process, its Postgres container
# and the engine worktree. Leaves WORKDIR's logs in place.
set -uo pipefail
WORKDIR=${WORKDIR:-${TMPDIR:-/tmp}/polyant-cli-sync}
[ -f "$WORKDIR/state.env" ] || { echo "nothing to stop in $WORKDIR" >&2; exit 0; }
. "$WORKDIR/state.env"
if [ -f "$WORKDIR/engine.pid" ]; then
  # ephemeral-up starts the engine in a session of its own, so its pid is also
  # its process group: signalling the group reaches the tsx child npx leaves
  # behind, and nothing else listening on the port.
  kill -TERM -- "-$(cat "$WORKDIR/engine.pid")" 2>/dev/null
fi
docker rm -f "$PG_NAME" >/dev/null 2>&1
git -C "$ENGINE_DIR" worktree remove --force "$ENGINE" 2>/dev/null
rm -f "$WORKDIR/state.env" "$WORKDIR/engine.pid" "$WORKDIR"/*.tok
echo "stopped; logs kept in $WORKDIR" >&2
