#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

source "$REPO_DIR/.e3d-corp/instance/futco/futco.env"

cd "$REPO_DIR"
exec /usr/local/bin/node ops/reports/pollCalendarBookings.js --instance futco
