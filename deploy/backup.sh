#!/usr/bin/env bash
set -euo pipefail

backup_dir=/var/lib/primal/backups
database=/var/lib/primal/primal.db
mkdir -p "$backup_dir"
destination="$backup_dir/primal-$(date -u +%F).db"
sqlite3 "$database" ".backup '$destination'"
find "$backup_dir" -maxdepth 1 -type f -name 'primal-*.db' -mtime +6 -delete

