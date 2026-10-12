#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

source "$REPO_DIR/.e3d-corp/instance/futco/futco.env"
# x.engagementReply drafts with the "claude" provider, against the same
# metered Claude API credit e3d-pilot's own automation uses (not the
# interactive subscription login) - see ~/.config/e3d-pilot/run-metered.sh.
source "$HOME/.config/e3d-pilot/anthropic-api-key"

cd "$REPO_DIR"
exec /usr/local/bin/node ops/reports/runXEngagement.js --instance futco
