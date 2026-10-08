# Cloud deployment

Local Cognitive Cloud (`apps/cloud`) runs as the Compose project `local-cognitive`:
Postgres 17, one-shot migrations and the API (Node 24). Images are multi-arch.

## Production host (Oracle, Ubuntu 24.04 arm64)

Deployed on 2026-10-08 to `ubuntu@92.5.190.104`, directory `/opt/local-cognitive`.
The host also runs Quantir (Compose project `compose`), whose Caddy owns ports 80/443,
so this stack uses `compose.edge.yml`:

- the API joins Quantir's `compose_edge` network as `local-cognitive-cloud:8080`;
- Postgres is reachable only on the project's own network;
- the site block `caddy-site.caddy` is installed as `/opt/caddy-sites/local-cognitive.caddy`,
  which Quantir's Caddyfile imports (`import /etc/caddy/sites/*.caddy`, read-only mount of
  `/opt/caddy-sites`; repository `defi-risk-engine`, `deploy/compose/`).

DNS: `api.local-cognitive.com` needs an A record to the host IP. Use **DNS only** (no
Cloudflare proxy): Caddy obtains the certificate itself, and relay WebSockets are not
subject to proxy idle timeouts.

The Quantir release deployed on 2026-10-08 predates the import, so the same block is also
appended to that release's Caddyfile (original backed up in `/opt/local-cognitive/backups/`).
The next Quantir release must include the import and the mount; afterwards check
`curl https://api.local-cognitive.com/health`. After changing `caddy-site.caddy`, copy it to
`/opt/caddy-sites/local-cognitive.caddy` and run
`docker exec compose-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`.

`.env` (mode 600) holds `POSTGRES_PASSWORD`, generated on the host; it never leaves it.

## Update

From the repository root on a development machine:

```sh
rsync -az --relative --exclude .env -e "ssh -i ~/.ssh/quantir-oci" package.json package-lock.json \
  apps/cloud/package.json apps/cloud/tsconfig.json apps/cloud/src apps/cloud/migrations \
  deploy/cloud ubuntu@92.5.190.104:/opt/local-cognitive/
ssh -i ~/.ssh/quantir-oci ubuntu@92.5.190.104 \
  'cd /opt/local-cognitive/deploy/cloud && docker compose -p local-cognitive -f compose.yml -f compose.edge.yml up -d --build'
```

Migrations run before the API starts and are forward-only; take a backup before
releasing a migration. Never use `docker compose down -v`: it deletes the database volume.

## Backups

`backup.sh` runs daily at 03:17 (ubuntu's crontab): `pg_dump --format=custom`, verified
with `pg_restore --list`, kept 14 days in `/opt/local-cognitive/backups/postgres`; any failed
step exits non-zero and leaves no file. `verify-restore.sh` runs on Sundays at 04:47 and
restores the newest dump into a throwaway database. Both log to `backups/backup.log`.

Off-host copies: create an OCI Object Storage bucket and a pre-authenticated request that
allows object writes, then store its URL (ending in `/o/`) in
`/opt/local-cognitive/backups/postgres/upload-url` with mode 600. Without it every backup logs
a warning: a backup on the same disk does not survive losing the server.

Restore (stop the API first: `docker stop local-cognitive-cloud-1`):

```sh
docker exec -i local-cognitive-postgres-1 pg_restore -U lc_cloud -d lc_cloud --clean --if-exists --no-owner < lc_cloud-<time>.dump
```

## Own TLS proxy

On a host with free ports 80/443, use the bundled Caddy instead of `compose.edge.yml`:
`docker compose -p local-cognitive --profile standalone-proxy up -d --build`.
