#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

source "$REPO_DIR/.e3d-corp/instance/futco/futco.env"
source "$HOME/.config/e3d-pilot/anthropic-api-key"

cd "$REPO_DIR"
# Weekly: queues x-post / linkedin-post Proposals for the owner to approve. Add
# --with-ads to also queue a pilot-ad-campaign proposal (still approval-only).
exec /usr/local/bin/node ops/reports/runPilotContent.js --instance futco "$@"
