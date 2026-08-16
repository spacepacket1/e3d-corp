#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

source "$REPO_DIR/.e3d-corp/instance/futco/futco.env"
source "$HOME/.e3d-pilot-ses.env"

cd "$REPO_DIR"
exec /usr/local/bin/node bin/e3d-corp anchor publish --instance futco
