#!/usr/bin/env bash
# Scheduled YouTube channel poll (sample + scan + measure). Read-only against YouTube; no LLM; no channel writes.
# NOT installed anywhere automatically. Suggested crontab line (every 3 hours; inside the 6h sample interval it is a
# no-op, so this just guarantees a prompt retry after a failed run):
#   0 */3 * * * /Users/mini/e3d-corp/ops/run/run-youtube-poll.sh >> /Users/mini/e3d-corp/.e3d-corp/instance/futco/youtube-poll.log 2>&1
# Needs YOUTUBE_API_KEY (or research.youtube.apiKeyFile) - see docs/youtube-monitor.md.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

source "$REPO_DIR/.e3d-corp/instance/futco/futco.env"

cd "$REPO_DIR"
exec /usr/local/bin/node ops/reports/pollYoutube.js --instance futco
