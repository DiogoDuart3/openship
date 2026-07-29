# Openship 0.4.8 Edge Cutover Plan

Written 2026-07-29 after a live attempt on this box broke all 7 hosted sites
(`525` errors) because `docker/docker-compose.yml` switched the edge's storage
from Docker-managed named volumes to host bind mounts, with no migration step.
This plan is the deliberate, scripted version of that cutover — run it in a
maintenance window, not as a live `pull && up`.

The code-level side of the update (rebasing the fork's local commits onto
`origin/main`) is already solved and safe to redo — see the `update/v0.4.8-eval`
git branch, which has the 3-conflict resolution already applied cleanly. This
plan is only about the **data/volume migration** for `edge` (and `api`, which
shares the same volumes — see the footgun section, this is not optional).

## 0. What actually changed upstream

`git diff v0.4.5 origin/main -- docker/docker-compose.yml` — the `api` and
`edge` services both moved from named volumes to host bind mounts:

| Purpose | Old (named volume) | New (bind mount, host path) | Container path |
|---|---|---|---|
| vhost configs | `openship_sites` | `/var/lib/openship/edge/sites-enabled` | `/usr/local/openresty/nginx/conf/sites-enabled` |
| TLS certs | `openship_certs` | `/etc/letsencrypt` (real host path) | `/etc/letsencrypt` |
| ACME challenge webroot | `openship_acme` | `/var/lib/openship/edge/acme` | `/var/www/acme` |
| static site files | `openship_static` | `/opt/openship/static` (real host path) | `/opt/openship/static` |

On this box the actual Docker volume names (project `openship`) are
`openship_openship_sites`, `openship_openship_certs`, `openship_openship_acme`,
`openship_openship_static`.

**Important, install-specific wrinkle:** this box runs `api` from the *root*
`docker-compose.yml` ("SaaS/from-source control plane" — see its header
comment: "there is deliberately NO Docker socket and NO edge") plus a local
override (`docker/docker-compose.host-control.yml`) that re-adds the Docker
socket and these same 4 named volumes so `api` can actually build/deploy and
write routes `edge` can see. **The root `docker-compose.yml` is untouched by
upstream's bind-mount migration** — only `docker/docker-compose.yml` changed.
That means if `edge` moves to bind mounts and `api`'s override keeps pointing
at the old named volumes, they silently stop sharing storage: `api` writes new
routes to a volume nobody reads, `edge` never sees them. **Both must move
together.** This plan's `docker-compose.host-control.yml` edit in step 3
handles that.

## 1. Pre-flight checks

Run these first. If any fail, stop and investigate before continuing.

```bash
cd ~/openship

# Working tree must be clean, WIP committed (not stashed)
git status --porcelain   # expect empty
git log -1 --oneline     # confirm you're on the branch you think you're on

# Confirm the rebased branch with the 3-conflict resolution still exists
git log --oneline update/v0.4.8-eval -3

# Confirm current baseline mounts on api (docker.sock + 4 named volumes +
# host-control-key — all 6 lines). If this is short, fix that FIRST — see
# docker/docker-compose.host-control.yml; api silently loses deploy/routing
# capability without these on every recreate.
docker inspect openship-api-1 --format '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'

# Confirm edge is still on the old named-volume scheme (sanity: should show
# "volume", not "bind", for all 4 routing mounts)
docker inspect openship-edge --format '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'

# Disk headroom (volumes are tiny — KB range — but check anyway)
df -h /
docker system df -v | grep -E "openship_sites|openship_certs|openship_acme|openship_static"

# No queued/in-progress migration runs (would race a container recreate)
docker exec openship-postgres-1 psql -U openship -d openship -c \
  "SELECT id, project_name, status FROM docker_migration_run WHERE status IN ('queued','running');"
# expect 0 rows

# Fresh DB snapshot (independent of the volume migration, but do it anyway —
# cheap insurance for the same maintenance window)
docker exec openship-postgres-1 pg_dump -U openship -Fc openship \
  > ~/openship/openship-pre-0.4.8-cutover-$(date +%Y%m%d-%H%M).dump
ls -la ~/openship/openship-pre-0.4.8-cutover-*.dump

# Check whether /var/lib/openship/edge/* already has STALE data from a prior
# aborted attempt (it does on this box, from tonight's incident — wipe it
# clean before the real cutover so you're not trusting a partial snapshot)
ls -la /var/lib/openship/edge/sites-enabled/ /var/lib/openship/edge/acme/ 2>&1
```

## 2. Prepare the new host paths (safe to do ahead of time, no downtime)

This only creates directories and copies data *into new locations* — it does
not touch anything live. Run it any time before the cutover window, then
re-run the copy step again right before cutover to catch anything written in
between (a second copy is cheap and idempotent — `cp -a` overwrites).

```bash
# Wipe any stale partial copy from a prior aborted attempt
sudo rm -rf /var/lib/openship/edge/sites-enabled /var/lib/openship/edge/acme
sudo mkdir -p /var/lib/openship/edge/sites-enabled /var/lib/openship/edge/acme

# sites-enabled: named volume -> new bind-mount path
docker run --rm \
  -v openship_openship_sites:/src \
  -v /var/lib/openship/edge/sites-enabled:/dst \
  alpine sh -c 'cp -av /src/. /dst/'

# acme webroot: named volume -> new bind-mount path
docker run --rm \
  -v openship_openship_acme:/src \
  -v /var/lib/openship/edge/acme:/dst \
  alpine sh -c 'cp -av /src/. /dst/'

# certs: named volume -> /etc/letsencrypt (the REAL host path — check what's
# already there first; on this box it already had a stale/partial subset of
# domains from a previous non-containerized install, so this is a merge, not
# a fresh copy — cp -a will not delete anything already present, only add/
# overwrite matching names)
sudo docker run --rm \
  -v openship_openship_certs:/src \
  -v /etc/letsencrypt:/dst \
  alpine sh -c 'cp -a /src/. /dst/'

# static: named volume -> /opt/openship/static (also a real host path)
sudo mkdir -p /opt/openship/static
docker run --rm \
  -v openship_openship_static:/src \
  -v /opt/openship/static:/dst \
  alpine sh -c 'cp -av /src/. /dst/'

# Verify: every vhost that's in the named volume must now also be in the new
# host path (compare counts, then diff the actual filenames)
diff \
  <(docker run --rm -v openship_openship_sites:/d alpine ls /d | sort) \
  <(ls /var/lib/openship/edge/sites-enabled | sort)
# expect empty output

diff \
  <(docker run --rm -v openship_openship_certs:/d alpine sh -c 'ls /d/live' | sort) \
  <(sudo ls /etc/letsencrypt/live | sort)
# expect empty output (both should list the SAME set of domain directories + README)
```

## 3. The `docker/docker-compose.yml` dashboard→api footgun

**This is the second thing that broke tonight, separately from the volume
issue.** `docker/docker-compose.yml`'s `dashboard` service has
`depends_on: api: condition: service_healthy` — its OWN `api` service
definition (the pull-based `ghcr.io/oblien/openship-api:${OPENSHIP_VERSION}`
one), not the fork-built one this box actually runs. Running
`docker compose -f docker/docker-compose.yml up -d dashboard` (or `edge`, same
dependency graph) pulls `api` into scope and **silently replaces the
fork-built `openship-api-1` container with the stock prebuilt image**, wiping
out every local fix.

**Prevention — do both, every time, no exceptions:**

1. Always pass `--no-deps` when touching `dashboard`/`edge` via
   `docker/docker-compose.yml`:
   ```bash
   docker compose -f docker/docker-compose.yml --env-file .env up -d --no-deps edge dashboard
   ```
2. Always explicitly unset `COMPOSE_FILE` for any command targeting
   `docker/docker-compose.yml`. This box's `.env` sets
   `COMPOSE_FILE=docker-compose.yml:docker/docker-compose.host-control.yml`
   (added to fix a *different* mount-loss bug — see git history on that file).
   A bare `docker compose ...` now defaults to the ROOT compose file. Mixing
   an explicit `-f docker/docker-compose.yml` with that env var in place is
   exactly what caused the accidental `api` swap tonight. Always:
   ```bash
   env -u COMPOSE_FILE docker compose -f docker/docker-compose.yml --env-file .env <command>
   ```

If `api` ever does get swapped by accident, the fix is fast — the fork-built
image is still cached locally (`docker images openship-api`), just re-run
`docker compose up -d api` (root compose file, default `COMPOSE_FILE`
resolution) to recreate it from that image again.

## 4. Cutover sequence

Estimated downtime: **~20–40 seconds of edge-facing outage** (all 7 hosted
sites unreachable while `edge` recreates) plus a **separate, non-overlapping
~10–15 second control-plane blip** (dashboard/API UI only, not the hosted
sites) while `api` recreates. Do this in a low-traffic window. If step 2's
data was prepared in advance, this is just container recreation — no data
copying happens live.

```bash
cd ~/openship

# 1. Re-run the data copy from step 2 one more time, right before cutover,
#    to catch anything written since the earlier prep (idempotent, seconds).
#    [repeat the 4 `docker run --rm ... cp -a` commands from section 2]

# 2. Rebase the fork onto upstream (or reuse update/v0.4.8-eval if it's still
#    current — check `git log origin/main -1` hasn't moved since it was built)
git fetch origin --tags
git checkout -b update/v0.4.8-cutover feat/add-this-server-button
git rebase origin/main
# Expect exactly the 3 conflicts already solved once on update/v0.4.8-eval:
#   packages/adapters/src/index.ts        -> keep both exports (union)
#   apps/api/src/modules/mail/mail.service.ts -> comment-only, merge prose
#   packages/adapters/src/platform.ts     -> keep OUR isLocalTarget/config.localHost
#     side, discard upstream's reverted-to-old useDockerEdge formula (see
#     UPGRADE-0.4.8-PLAN.md §0 for why: root docker-compose.yml still injects
#     a non-null executor for the "This Server" row, so useDockerEdge would
#     silently go false without this fix)
# If ANY conflict looks different from this, STOP — something upstream moved
# — do not force through an unfamiliar conflict. `git rebase --abort` and
# reassess before continuing.

# 3. Type-check before building
docker run --rm -v /home/ubuntu/openship:/repo -w /repo/apps/api \
  oven/bun:1.3.3 bun x tsc --noEmit -p tsconfig.json
# expect only the pre-existing unrelated `mail.routes.ts recheckPort25` error,
# nothing else new

# 4. Update docker/docker-compose.host-control.yml to point api's shared
#    volumes at the SAME bind-mount paths edge is about to use (this is the
#    fix for the split-brain risk in §0 — api and edge MUST share storage).
#    Edit the file: replace the 4 `openship_sites`/`openship_certs`/
#    `openship_acme`/`openship_static` volume lines with:
#      - /var/lib/openship/edge/sites-enabled:/usr/local/openresty/nginx/conf/sites-enabled
#      - /etc/letsencrypt:/etc/letsencrypt
#      - /var/lib/openship/edge/acme:/var/www/acme
#      - /opt/openship/static:/opt/openship/static
#    and DELETE the top-level `volumes: openship_sites: / openship_certs: /
#    openship_acme: / openship_static:` block this file currently declares
#    (bind mounts don't need a top-level volumes entry).

# 5. Rebuild + recreate api (root compose file, picks up the host-control
#    override automatically via COMPOSE_FILE in .env)
docker compose build api
docker compose up -d api
docker inspect openship-api-1 --format '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
# expect: bind host-control-key, bind docker.sock, and 4 BIND mounts (not
# "volume") to /var/lib/openship/edge/... and /etc/letsencrypt and
# /opt/openship/static

# 6. Bump the version pin and pull edge + dashboard
sed -i 's/^OPENSHIP_VERSION=.*/OPENSHIP_VERSION=0.4.8/' .env
env -u COMPOSE_FILE docker compose -f docker/docker-compose.yml --env-file .env pull dashboard edge

# 7. Recreate edge + dashboard — --no-deps is mandatory (see §3)
env -u COMPOSE_FILE docker compose -f docker/docker-compose.yml --env-file .env \
  up -d --no-deps edge dashboard

# 8. Immediately confirm api did NOT get swapped by the previous command
docker inspect openship-api-1 --format 'Image={{.Config.Image}}'
# expect: openship-api  (NOT ghcr.io/oblien/openship-api:0.4.8)
# If it got swapped anyway: `docker compose up -d api` (root compose,
# no -f needed) restores it from the still-cached local image immediately.
```

## 5. Rollback (if anything looks wrong at any point)

Full reverse — this is exactly the sequence used tonight and confirmed to
work cleanly:

```bash
cd ~/openship

# 1. Version pin back
sed -i 's/^OPENSHIP_VERSION=.*/OPENSHIP_VERSION=0.4.5/' .env

# 2. Branch back to the pre-update commit
git checkout feat/add-this-server-button

# 3. Revert docker-compose.host-control.yml's api volumes back to the named
#    volumes (git checkout the pre-cutover version of that file, or manually
#    restore the openship_sites/openship_certs/openship_acme/openship_static
#    lines + the top-level `volumes:` block declaring them)
git checkout feat/add-this-server-button -- docker/docker-compose.host-control.yml

# 4. Rebuild + recreate api from the reverted branch
docker compose build api
docker compose up -d api
docker inspect openship-api-1 --format '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
# expect: back to "volume" (not "bind") for the 4 routing mounts

# 5. Recreate edge + dashboard using the original named-volume compose file
git checkout feat/add-this-server-button -- docker/docker-compose.yml
env -u COMPOSE_FILE docker compose -f docker/docker-compose.yml --env-file .env \
  up -d --no-deps edge dashboard

# 6. Verify (see checklist below)
```

The named volumes (`openship_openship_sites` etc.) are never deleted by this
plan — only copied FROM. Rollback needs no data restore, just pointing the
containers back at them. The `openship-pre-0.4.8-cutover-*.dump` from §1 is a
last-resort DB fallback only — the 2 new migrations (`0071_gh_device_token`,
`0072_gh_device_token_method`) are purely additive (`ALTER TABLE ... ADD
COLUMN IF NOT EXISTS`) and harmless to leave applied even after a code
rollback, so restoring the dump should not be necessary.

## 6. Post-cutover verification checklist

```bash
# Container health + images
docker ps --format 'table {{.Names}}\t{{.Status}}' | sort
docker inspect openship-api-1 --format 'Image={{.Config.Image}}'         # openship-api (local)
docker inspect openship-dashboard-1 --format 'Image={{.Config.Image}}'   # ghcr.io/oblien/openship-dashboard:0.4.8
docker inspect openship-edge --format 'Image={{.Config.Image}}'          # ghcr.io/oblien/openship-edge:0.4.8

# All 7 sites
for d in 360peliculas.pt faltou.pt valvo.shop openship.diogoduarte.net \
         openpanel.diogoduarte.net openpanel-api.diogoduarte.net webmail.diogoduarte.net; do
  echo "$d: $(curl -s -o /dev/null -w '%{http_code}' -m 8 https://$d/)"
done
# expect: 200 for app sites, 307 for the two dashboard-fronted ones
# (openship.diogoduarte.net, openpanel.diogoduarte.net) — matches pre-cutover

# Analytics still flowing (mint a temp PAT if needed — see the analytics-fix
# session notes for the exact insert; remember to revoke it after)
curl -s "http://127.0.0.1:4000/api/analytics/overview?projectId=proj_Hw-w9jSMLS5d5nph" \
  -H "Authorization: Bearer <temp-pat>" | head -c 200
docker exec openship-postgres-1 psql -U openship -d openship -c \
  "SELECT count(*) FROM server_analytics;"
# expect: non-zero, and a re-check a minute later should show a higher count

# openpanel-worker unaffected (it's a separate compose project entirely —
# this cutover should never touch it, but confirm anyway)
docker inspect openship-openpanel-openpanel-worker --format 'RestartCount={{.RestartCount}}'

# Dashboard "Action Required" — log into the dashboard UI and confirm no
# banner/badge appears on the projects list or individual project pages.
# (No API equivalent found for this in tonight's session — it's a UI-only
# check; do it visually.)

# Route write-through sanity: make a trivial no-op domain edit (e.g. toggle
# a service's exposed flag off/on) through the dashboard, then confirm the
# edge picks it up:
docker exec openship-edge sh -c 'ls -la /usr/local/openresty/nginx/conf/sites-enabled/ | tail -5'
# the affected vhost's mtime should update to just now — proves api's write
# (via the shared bind mount) is actually visible to edge, closing the
# split-brain risk this plan exists to prevent

# Cert renewal sanity (not urgent day-of, but confirm before the next
# certbot cron cycle): certs are readable inside edge
docker exec openship-edge sh -c 'ls /etc/letsencrypt/live/'
# expect: same domain list as pre-cutover
```

If every item above passes, the cutover is complete and `OPENSHIP_VERSION=0.4.8`
can stay pinned. Delete `update/v0.4.8-cutover` (or `update/v0.4.8-eval`) once
you're confident — they were throwaway branches, not meant to be long-lived.
