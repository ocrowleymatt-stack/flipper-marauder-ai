#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
test -f "$root/ops/backup/RESTORE.md"
grep -q 'sha256' "$root/ops/backup/RESTORE.md"
grep -q 'Do \*\*not\*\* start Nexus' "$root/ops/backup/RESTORE.md"
echo "backup restore contract: ok"
