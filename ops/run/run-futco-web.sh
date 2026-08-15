#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

source "$REPO_DIR/.e3d-corp/instance/futco/futco.env"
source "$HOME/.e3d-pilot-ses.env"
export AWS_DEFAULT_REGION="us-east-2"

cd "$REPO_DIR"
exec node bin/e3d-corp web --instance futco
