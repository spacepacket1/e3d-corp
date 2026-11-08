#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

source "$REPO_DIR/.e3d-corp/instance/futco/futco.env"
source "$HOME/.e3d-pilot-ses.env"
export AWS_DEFAULT_REGION="us-east-2"

cd "$REPO_DIR"
# --wildcard adds the optional "Ideas worth trying" and "Moonshot" sections; any failure leaves them out.
# Brain paths come from instance.json (pilotBrief.wildcard.brainConfig / brainMain).
exec /usr/local/bin/node ops/reports/pilotBrief.js --instance futco --wildcard
