#!/usr/bin/env bash
# Restores the newest backup into a throwaway database and checks it, without touching
# lc_cloud. Run weekly and after changing backup.sh.
set -euo pipefail
dir=/opt/local-cognitive/backups/postgres
container=local-cognitive-postgres-1
latest=$(ls -1t "$dir"/lc_cloud-*.dump 2>/dev/null | head -1)
[ -n "$latest" ] || { echo "no backup found in $dir" >&2; exit 1; }
check=lc_restore_check
psql() { docker exec -i "$container" psql -U lc_cloud -v ON_ERROR_STOP=1 -qAt "$@"; }
psql -d postgres -c "DROP DATABASE IF EXISTS $check" -c "CREATE DATABASE $check"
trap 'psql -d postgres -c "DROP DATABASE IF EXISTS $check" >/dev/null' EXIT
docker exec -i "$container" pg_restore -U lc_cloud -d "$check" --no-owner --exit-on-error < "$latest"
migrations=$(psql -d "$check" -c "SELECT count(*) FROM schema_migrations")
expected=$(psql -d lc_cloud -c "SELECT count(*) FROM schema_migrations")
accounts=$(psql -d "$check" -c "SELECT count(*) FROM accounts")
[ "$migrations" = "$expected" ] || { echo "restore check failed: $migrations of $expected migrations" >&2; exit 1; }
echo "$(date -u +%FT%TZ) restore check ok: $(basename "$latest"), $migrations migrations, $accounts accounts"
