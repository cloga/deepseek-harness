#!/usr/bin/env bash
# Keep the hook entrypoint; CI invokes the same rule with explicit base/head SHAs.
set -euo pipefail
exec node "$(dirname "$0")/check-vendor-manifest.mjs" "$@"
