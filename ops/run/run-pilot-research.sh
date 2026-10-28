#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

source "$REPO_DIR/.e3d-corp/instance/futco/futco.env"
# pilot.competitorBrief drafts with the "claude" provider on the metered API credit
# (same key file as run-x-engagement.sh).
source "$HOME/.config/e3d-pilot/anthropic-api-key"

cd "$REPO_DIR"
exec /usr/local/bin/node ops/reports/runPilotResearch.js --instance futco
