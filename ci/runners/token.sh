#!/usr/bin/env bash
# Print a one-hour runner registration token for a repository (default hamstu/kimochi)
# or, with --org NAME, an organisation. Needs `gh` logged in with admin on the target.
set -euo pipefail
if [[ "${1:-}" == --org ]]; then
  gh api -X POST "orgs/$2/actions/runners/registration-token" -q .token
else
  gh api -X POST "repos/${1:-hamstu/kimochi}/actions/runners/registration-token" -q .token
fi
