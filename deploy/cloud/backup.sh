#!/usr/bin/env bash
# Daily backup of the Cloud database (pg_dump custom format), kept for 14 days.
# Off-host copy: put an OCI Object Storage pre-authenticated request URL for a bucket
# (ending in /o/) into $dir/upload-url (mode 600); each dump is then uploaded there.
set -euo pipefail
dir=/opt/local-cognitive/backups/postgres
container=local-cognitive-postgres-1
mkdir -p "$dir"
umask 077
name="lc_cloud-$(date -u +%Y%m%dT%H%M%SZ).dump"
tmp="$dir/.$name.tmp"
trap 'rm -f "$tmp"' EXIT
docker exec "$container" pg_dump -U lc_cloud -d lc_cloud --format=custom --no-owner > "$tmp"
# A truncated or empty dump fails here instead of replacing a good one.
docker exec -i "$container" pg_restore --list > /dev/null < "$tmp"
mv "$tmp" "$dir/$name"
echo "$(date -u +%FT%TZ) backup $name $(stat -c %s "$dir/$name") bytes"
if [ -s "$dir/upload-url" ]; then
  curl -fsS --retry 3 -T "$dir/$name" "$(cat "$dir/upload-url")$name"
  echo "$(date -u +%FT%TZ) uploaded $name"
else
  echo "$(date -u +%FT%TZ) WARNING: no off-host copy (missing $dir/upload-url)" >&2
fi
find "$dir" -name 'lc_cloud-*.dump' -mtime +14 -delete
find "$dir" -name 'lc_cloud-*.sql.gz' -mtime +14 -delete
