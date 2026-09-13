#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
doc="$root/ops/deploy/TRANSACTIONAL-DEPLOY.md"
test -f "$doc"
grep -q 'Flip pointer' "$doc"
grep -q 'On verify failure' "$doc"
grep -q 'A CI green build is \*\*not\*\* production health' "$doc"
echo "transactional deploy contract: ok"
