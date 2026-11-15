#!/usr/bin/env bash
# Smoke test a built closerouter binary: start the server on a throwaway sqlite
# db and drive the HTTP surface. The FFI symbols only bind in a built
# executable, so this is the only check that proves sqlite works on the
# platform the binary was built for.
#
#   bash scripts/smoke-test.sh [path-to-binary]   (default: dist/closerouter)
#   SMOKE_PORT=6801 bash scripts/smoke-test.sh    (default port: 6799)
set -euo pipefail

BINARY="${1:-dist/closerouter}"
PORT="${SMOKE_PORT:-6799}"
KEY="sk-smoke"
BASE_URL="http://127.0.0.1:$PORT"
WORKDIR="$(mktemp -d)"
SERVER_PID=""

cleanup () {
    if [[ -n "$SERVER_PID" ]]; then
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
    rm -rf "$WORKDIR"
}
trap cleanup EXIT

fail () {
    echo "smoke test failed: $*" >&2
    if [[ -s "$WORKDIR/server.log" ]]; then
        echo '--- server log ---' >&2
        tail -n 20 "$WORKDIR/server.log" >&2
    fi
    exit 1
}

api () {
    local method="$1" path="$2" body="${3:-}"

    if [[ -n "$body" ]]; then
        curl -fsS -m 5 -X "$method" -H "Authorization: Bearer $KEY" \
            -H 'Content-Type: application/json' --data "$body" "$BASE_URL$path"
    else
        curl -fsS -m 5 -X "$method" -H "Authorization: Bearer $KEY" "$BASE_URL$path"
    fi
}

command -v curl >/dev/null || fail 'curl is unavailable'
[[ -x "$BINARY" ]] || fail "binary not found or not executable: $BINARY (run \`npm run build:cli\`)"

if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
    exec 3>&-
    fail "port $PORT is already in use - set SMOKE_PORT to a free port"
fi

echo "smoke testing $BINARY ($("$BINARY" version)) on port $PORT"

cat > "$WORKDIR/closerouter.json" <<JSON
{
    "port": $PORT,
    "key": "$KEY",
    "db": "$WORKDIR/usage.db",
    "providers": {
        "mock": {
            "base_url": "http://127.0.0.1:9/v1",
            "api_key": "sk-mock",
            "models": ["mock-1"]
        }
    }
}
JSON

"$BINARY" -c "$WORKDIR/closerouter.json" > "$WORKDIR/server.log" 2>&1 &
SERVER_PID=$!

for _ in {1..100}; do
    kill -0 "$SERVER_PID" 2>/dev/null || fail 'server exited during startup'
    api GET /status >/dev/null 2>&1 && break
    sleep 0.2
done

status="$(api GET /status)" || fail 'GET /status did not answer'
[[ "$status" == *'"status":"ok"'* ]] || fail "GET /status: $status"
[[ "$status" == *'"sqlite":"'* ]] || fail "sqlite is not bound: $status"

api GET /v1/models >/dev/null || fail 'GET /v1/models did not answer'

api POST /logs '{
    "requestId": "smoke-1",
    "time": 1700000000000,
    "method": "POST",
    "path": "/v1/chat/completions",
    "provider": "mock",
    "model": "mock-1",
    "status": 200,
    "durationMs": 25,
    "inputTokens": 30,
    "outputTokens": 12
}' | grep -q '"ok":true' || fail 'POST /logs did not store the row'

usage="$(api GET /usage)" || fail 'GET /usage did not answer'
[[ "$usage" == *'"count":1'* ]] || fail "GET /usage did not report the stored row: $usage"

echo "smoke test passed: $(api GET /status | grep -o '"sqlite":"[^"]*"')"
