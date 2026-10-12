#!/bin/bash
# Starts a throwaway Polyant engine at one revision, with its own
# Postgres, a management key (pk_), a personal token (pat_) and a CLI wrapper
# pointed at it. Nothing it creates touches the engine checkout or another
# instance: the engine runs from a detached worktree, the database from its own
# container, on ports of its own.
#
# Usage: ephemeral-up.sh [engine-rev]          (default origin/develop)
# Env:   ENGINE_DIR      the engine checkout (default: a `polyant` checkout beside the CLI repo).
#                        Issuing the credentials needs the key routes Polyant Enterprise serves.
#        WORKDIR         where state, logs and the wrapper live (default $TMPDIR/polyant-cli-sync)
#        PG_PORT, API_PORT                                 (default 55499, 4499)
#        PLUGIN_DIRS     plugins to load (default: none)
# Prints the wrapper path last. Tear down with ephemeral-down.sh.
set -euo pipefail

REV=${1:-origin/develop}
HERE=$(cd "$(dirname "$0")" && pwd)
CLI_COMMON=$(git -C "$HERE" rev-parse --path-format=absolute --git-common-dir)
AI_ROOT=$(cd "$CLI_COMMON/../.." && pwd)
CLI_TOP=$(git -C "$HERE" rev-parse --show-toplevel)
ENGINE_DIR=${ENGINE_DIR:-$AI_ROOT/polyant}
WORKDIR=${WORKDIR:-${TMPDIR:-/tmp}/polyant-cli-sync}
PG_PORT=${PG_PORT:-55499}
API_PORT=${API_PORT:-4499}
# Named after its port: two instances on different ports keep separate
# containers, and two on the same port could not run side by side anyway.
PG_NAME=polyant-cli-sync-pg-$PG_PORT
PLUGIN_DIRS=${PLUGIN_DIRS:-}

mkdir -p "$WORKDIR"
ENGINE=$WORKDIR/engine

echo "• engine worktree at $REV" >&2
git -C "$ENGINE_DIR" fetch -q origin
SHA=$(git -C "$ENGINE_DIR" rev-parse "$REV")
# A worktree left by an earlier run is reused only at the revision asked for:
# state.env records $SHA as what was tested, so running anything else would
# make that record false. A stale one is rebuilt, dependencies included.
if [ -d "$ENGINE" ] && [ "$(git -C "$ENGINE" rev-parse HEAD 2>/dev/null)" != "$SHA" ]; then
  echo "• the existing worktree is not at $SHA; rebuilding it" >&2
  git -C "$ENGINE_DIR" worktree remove --force "$ENGINE"
fi
[ -d "$ENGINE" ] || git -C "$ENGINE_DIR" worktree add -q --detach "$ENGINE" "$SHA"

# Reuse the checkout's dependencies only when its lockfile is the target's;
# otherwise install, which is slow but is the only honest choice.
if [ ! -e "$ENGINE/node_modules" ]; then
  if [ -d "$ENGINE_DIR/node_modules" ] && git -C "$ENGINE_DIR" diff --quiet "$SHA" -- package-lock.json packages/engine/package.json 2>/dev/null; then
    ln -s "$ENGINE_DIR/node_modules" "$ENGINE/node_modules"
    [ -d "$ENGINE_DIR/packages/engine/node_modules" ] && ln -s "$ENGINE_DIR/packages/engine/node_modules" "$ENGINE/packages/engine/node_modules"
  else
    echo "• npm ci (the checkout's lockfile differs from $REV)" >&2
    (cd "$ENGINE" && npm ci --silent)
  fi
fi

# Something already answering on the API port would pass the health check below
# in place of the engine just built — an earlier run's engine, most often.
if lsof -ti "tcp:$API_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $API_PORT is already in use; stop that process (ephemeral-down.sh, if it is ours) or set API_PORT" >&2
  exit 2
fi

echo "• postgres on :$PG_PORT" >&2
docker rm -f "$PG_NAME" >/dev/null 2>&1 || true
docker run -d --rm --name "$PG_NAME" -e POSTGRES_DB=polyant -e POSTGRES_USER=polyant \
  -e POSTGRES_PASSWORD=ephemeral-pw -p "$PG_PORT:5432" pgvector/pgvector:pg16 >/dev/null
until docker exec "$PG_NAME" pg_isready -U polyant -d polyant >/dev/null 2>&1; do sleep 1; done
sleep 2

cat > "$WORKDIR/engine.env" <<ENV
POSTGRES_HOST=localhost
POSTGRES_PORT=$PG_PORT
POSTGRES_DB=polyant
POSTGRES_USER=polyant
POSTGRES_PASSWORD=ephemeral-pw
API_PORT=$API_PORT
BASE_URL=http://localhost:$API_PORT
ENCRYPTION_KEY=$(openssl rand -hex 32)
AUTH_SECRET=$(openssl rand -hex 32)
AUTH_MODE=session
INITIAL_ADMIN_EMAIL=admin@cli-sync.local
INITIAL_ADMIN_PASSWORD=Ephemeral-Admin-1!
THROTTLE_ENABLED=false
LOG_LEVEL=warn
PLUGIN_DIRS=$PLUGIN_DIRS
ENV
set -a; . "$WORKDIR/engine.env"; set +a

echo "• migrations" >&2
(cd "$ENGINE/packages/engine" && npx tsx src/database/migrate.ts >/dev/null)

echo "• engine on :$API_PORT (log: $WORKDIR/engine.log)" >&2
# Only the engine command goes to the background, in a session of its own: a
# backgrounded `cd && …` list would keep this script's stdout open and make the
# caller wait — a pipe, or an agent's tool runner — for as long as the engine runs.
(
  cd "$ENGINE/packages/engine" || exit 1
  perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' npx tsx src/index.ts </dev/null >"$WORKDIR/engine.log" 2>&1 &
  echo $! >"$WORKDIR/engine.pid"
)
for _ in $(seq 1 90); do curl -sf "http://localhost:$API_PORT/health" >/dev/null && break; sleep 2; done
curl -sf "http://localhost:$API_PORT/health" >/dev/null || { tail -30 "$WORKDIR/engine.log" >&2; exit 3; }

echo "• credentials" >&2
read -r USER_ID ORG_ID < <(docker exec "$PG_NAME" psql -U polyant -d polyant -Atc \
  "select u.id || ' ' || o.id from users u, organizations o where u.email='admin@cli-sync.local' and o.is_default" | tr '|' ' ')
SESSION=$(node "$HERE/mint-session.mjs" "$ENGINE_DIR/node_modules" "$AUTH_SECRET" "$USER_ID" admin@cli-sync.local "$ORG_ID")
echo "$SESSION" >"$WORKDIR/session.tok"
B=http://localhost:$API_PORT
H="Authorization: Bearer $SESSION"
PERMS=$(curl -sf -H "$H" "$B/api/organizations/default/api-keys/permissions" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s).permissions)))')
curl -sf -H "$H" -H 'content-type: application/json' -X POST "$B/api/organizations/default/api-keys" \
  -d "{\"name\":\"cli-sync\",\"permissions\":$PERMS}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).token))' >"$WORKDIR/pk.tok"
curl -sf -H "$H" -H 'content-type: application/json' -X POST "$B/api/me/tokens" -d '{"name":"cli-sync-pat"}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).secret))' >"$WORKDIR/pat.tok"

mkdir -p "$WORKDIR/cli"
cat >"$WORKDIR/cli/polyant.yaml" <<YAML
default: ephemeral
targets:
  ephemeral:
    baseUrl: $B
    keyEnv: POLYANT_KEY_EPHEMERAL
  ephemeral-pat:
    baseUrl: $B
    keyEnv: POLYANT_PAT_EPHEMERAL
YAML
cat >"$WORKDIR/pc" <<WRAP
#!/bin/bash
# The CLI under test (this worktree's dist/), against the ephemeral engine.
# --target ephemeral-pat switches to the personal token.
cd "$WORKDIR/cli"
export POLYANT_KEY_EPHEMERAL=\$(cat "$WORKDIR/pk.tok")
export POLYANT_PAT_EPHEMERAL=\$(cat "$WORKDIR/pat.tok")
exec node "$CLI_TOP/dist/bin.js" "\$@"
WRAP
chmod +x "$WORKDIR/pc"
cat >"$WORKDIR/state.env" <<STATE
ENGINE_DIR=$ENGINE_DIR
ENGINE=$ENGINE
ENGINE_SHA=$SHA
PG_NAME=$PG_NAME
API_PORT=$API_PORT
STATE
echo "• ready: engine $SHA at $B" >&2
echo "$WORKDIR/pc"
