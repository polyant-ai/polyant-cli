#!/bin/bash
# Every NestJS route the engine declares at one revision, one "METHOD /path" per line, sorted.
# Usage: routes.sh <engine-repo> <rev>
# Diff two revisions:  diff <(routes.sh $E $BASE) <(routes.sh $E origin/develop)
set -euo pipefail
repo=$1; rev=$2
git -C "$repo" grep -l -E '@Controller\(' "$rev" -- 'packages/engine/src/**/*.ts' ':!*.test.ts' ':!*.spec.ts' \
  | sed "s|^$rev:||" | while read -r f; do
  git -C "$repo" show "$rev:$f" | awk '
    /@Controller\(/ { p=""; if (match($0,/@Controller\("[^"]*"/)) p=substr($0,RSTART+13,RLENGTH-14) }
    /@(Get|Post|Put|Patch|Delete|All|Sse)\(/ {
      match($0,/@(Get|Post|Put|Patch|Delete|All|Sse)\(/); m=substr($0,RSTART+1,RLENGTH-2)
      s=$0; sub(/.*@(Get|Post|Put|Patch|Delete|All|Sse)\(/,"",s); r=""
      if (match(s,/^"[^"]*"/)) r=substr(s,2,RLENGTH-2)
      print toupper(m)" /"p (r==""?"":"/"r) }'
done | sed 's#//#/#g' | sort -u
