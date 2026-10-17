#!/usr/bin/env bash
# Keeps a self-hosted runner's kept build caches from growing without bound. Run by every CI job
# from the checkout (kimochi-tauri/) before it builds, so it never races a build on the machine.
#
# Cargo never deletes old artifacts: each dependency bump or feature change leaves another copy in
# target/*/deps, so a kept target directory only grows (25 GB on a Linux runner after a week). The
# Rust target directories are wiped, and the next build is a cold one, when any of these hold:
#   - they were last wiped more than KIMOCHI_CACHE_MAX_DAYS ago (default 7);
#   - together they exceed KIMOCHI_CACHE_MAX_GB (default 25);
#   - the drive holding KIMOCHI_FREE_SPACE_PATH (default: this checkout) has less than
#     KIMOCHI_MIN_FREE_GB free (default 15). Set KIMOCHI_MIN_FREE_GB=0 where deleting cannot give
#     the space back (inside WSL the host drive only shrinks when the vhdx is compacted).
# Set the variables per machine in the runner's .env file (see ci/runners/README.md). Also drops
# runner diagnostic logs older than 30 days. node_modules, extensions/ and the staged OCR
# runtimes are small and stay.
set -uo pipefail

max_days=${KIMOCHI_CACHE_MAX_DAYS:-7}
max_gb=${KIMOCHI_CACHE_MAX_GB:-25}
min_free_gb=${KIMOCHI_MIN_FREE_GB:-15}
free_path=${KIMOCHI_FREE_SPACE_PATH:-.}
targets=(src-tauri/target capture-core/target oneocr-worker/target)
stamp=src-tauri/target/.kimochi-cache-since

summary() { [[ -n ${GITHUB_STEP_SUMMARY:-} ]] && echo "$*" >> "$GITHUB_STEP_SUMMARY"; echo "$*"; }
free_gb() { df -Pk "$free_path" 2>/dev/null | awk 'NR==2 { printf "%d", $4 / 1048576 }'; }

existing=()
for t in "${targets[@]}"; do [[ -d $t ]] && existing+=("$t"); done
size_gb=0
if ((${#existing[@]})); then
  size_gb=$(du -sk "${existing[@]}" 2>/dev/null | awk '{ s += $1 } END { printf "%d", s / 1048576 }')
fi
free=$(free_gb)

reason=
if ((${#existing[@]})); then
  if [[ ! -f $stamp ]]; then
    mkdir -p "$(dirname "$stamp")" && touch "$stamp"  # start the clock on caches from before this script
  elif [[ -n $(find "$stamp" -mtime +"$max_days" 2>/dev/null) ]]; then
    reason="older than $max_days days"
  fi
  if ((size_gb > max_gb)); then reason="${size_gb} GB > ${max_gb} GB cap"; fi
  if [[ -n $free ]] && ((min_free_gb > 0 && free < min_free_gb)); then reason="only ${free} GB free on the drive (< ${min_free_gb} GB)"; fi
fi

if [[ -n $reason ]]; then
  summary "Build cache: wiping ${existing[*]} (${size_gb} GB): $reason. This build is a cold one."
  rm -rf "${existing[@]}" 2>/dev/null || echo "::warning::Could not delete all of ${existing[*]} (files in use?)"
  mkdir -p "$(dirname "$stamp")" && touch "$stamp"
  free=$(free_gb)
else
  echo "Build cache: ${size_gb} GB (cap ${max_gb} GB, wiped weekly at ${max_days} days); ${free:-?} GB free."
fi
if [[ -n $free ]] && ((min_free_gb > 0 && free < min_free_gb)); then
  echo "::warning::Runner ${RUNNER_NAME:-} has only ${free} GB free at $free_path; a build may run out of space."
fi

# Runner diagnostic logs: _work/<repo> -> runner root.
diag="${RUNNER_WORKSPACE:-/nonexistent}/../../_diag"
[[ -d $diag ]] && find "$diag" -type f -mtime +30 -delete 2>/dev/null
exit 0
