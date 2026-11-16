#!/usr/bin/env bash
# Query the running app so this checks Tauri's lookup, not just installed files.
set -euo pipefail

app=$1
resource_test_dir=$(mktemp -d)
export XDG_CONFIG_HOME="$resource_test_dir/config"
export XDG_CACHE_HOME="$resource_test_dir/cache"
export XDG_DATA_HOME="$resource_test_dir/data"
export XDG_RUNTIME_DIR="$resource_test_dir/runtime"
mkdir -m 700 "$XDG_RUNTIME_DIR"

"$app/bin/kimochi" > "$resource_test_dir/app.log" 2>&1 &
app_pid=$!
trap 'kill "$app_pid" 2>/dev/null || true; wait "$app_pid" 2>/dev/null || true' EXIT

for ((attempt = 0; attempt < 30; attempt++)); do
  if "$app/bin/kimochi" ocr --json --no-start > "$resource_test_dir/engines.json" 2> "$resource_test_dir/client.log"; then
    python3 - "$resource_test_dir/engines.json" <<'PY'
import json
import sys

with open(sys.argv[1]) as file:
    engine = json.load(file)["engines"]["screenai"]
reason = engine.get("reason", "").lower()
assert not ("helper" in reason and "missing" in reason), engine
print("Screen AI worker discovered by the packaged app")
PY
    exit 0
  fi
  sleep 1
done

cat "$resource_test_dir/client.log" >&2
tail -30 "$resource_test_dir/app.log" >&2
exit 1
