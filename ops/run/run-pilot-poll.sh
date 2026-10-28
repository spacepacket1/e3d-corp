#!/usr/bin/env bash
# Scheduled Pilot product poll (ssh fetch of pilot-metrics + signal scan + revenue Outcome). Read-only against Pilot;
# no LLM; writes only to this instance's own event log. NOT installed anywhere automatically. Suggested crontab line
# (every 30 minutes; inside research.pilot.minPollIntervalMinutes a run makes no ssh call):
#   */30 * * * * /Users/mini/e3d-corp/ops/run/run-pilot-poll.sh >> /Users/mini/e3d-corp/.e3d-corp/instance/futco/pilot-poll.log 2>&1
# Needs research.pilot in the instance config and an ssh key for the read-only metrics user - see docs/pilot-monitor.md.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

source "$REPO_DIR/.e3d-corp/instance/futco/futco.env"

cd "$REPO_DIR"
exec /usr/local/bin/node ops/reports/pollPilot.js --instance futco
