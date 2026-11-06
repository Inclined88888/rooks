#!/usr/bin/env bash
# HTTP route smoke test — safety net for step 1.4.
#
# What it checks: after moving routes from `index.ts` to a module, NONE has
# disappeared. A 404 on a route that used to exist is the only regression
# extraction can produce, and it's also the only one no unit test catches.
# 200/400/500 are all accepted: this tests routing existence, not business
# behavior.
#
# `TIMON_HOME` is temporary and `TIMON_RESOURCE_GUARD_ENABLED=0`: without it,
# boot stops all mission systemd scopes on the machine (see P0.6).
set -euo pipefail

cd "$(dirname "$0")/../orchestrator"
npm run build >/dev/null

HOME_TMP=$(mktemp -d)
PORT=${PORT:-3999}
PID=
cleanup() {
  # Never `kill 0` nor an empty PID: that would signal the whole process
  # group, including the agent running this script.
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
  rm -rf "$HOME_TMP"
}
trap cleanup EXIT

TIMON_HOME="$HOME_TMP" PORT="$PORT" TIMON_RESOURCE_GUARD_ENABLED=0 \
  setsid bash -c \
  'echo $$ > "$TIMON_HOME/timon.pid"; exec node dist/index.js' >"$HOME_TMP/orchestrator.log" 2>&1 &

for _ in $(seq 1 60); do
  [ -z "$PID" ] && [ -s "$HOME_TMP/timon.pid" ] && PID=$(cat "$HOME_TMP/timon.pid")
  curl -sf "http://127.0.0.1:$PORT/api/agents" >/dev/null 2>&1 && break
  sleep 0.5
done
if ! curl -sf "http://127.0.0.1:$PORT/api/agents" >/dev/null 2>&1; then
  echo "cannot start on port $PORT" >&2
  cat "$HOME_TMP/orchestrator.log" >&2
  exit 1
fi

# GET routes without a path parameter: the only ones queryable blindly.
ROUTES=$(grep -ohE "app\.get\('(/api/[^']*)'" src/index.ts src/plugins-bundled/*/routes.ts \
  | sed -E "s/app\.get\('//; s/'$//" | grep -v ':' | sort -u)

fail=0
for r in $ROUTES; do
  # `-m 5` is mandatory: `/api/stream` is SSE, an unbounded curl would hang
  # on it forever and the smoke test would never return. A timeout counts as
  # a response: the route exists and started responding.
  code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$r"; true)
  rc=$?
  if [ "$rc" = "28" ] || [ -z "$code" ] || [ "$code" = "000" ]; then code=stream; fi
  printf '%-40s %s\n' "$r" "$code"
  # 404 = the route no longer exists (or was never mounted). This is THE
  # regression this step can produce, and the only one this script looks for.
  if [ "$code" = "404" ]; then fail=$((fail + 1)); fi
done

echo "── $(echo "$ROUTES" | wc -l) GET routes tested, $fail missing"
[ "$fail" -eq 0 ]
