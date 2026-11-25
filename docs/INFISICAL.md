# INFISICAL — self-hosted secret manager on CT 109

Native (non-container) Infisical deployment in a dedicated LXC on the `control`
PVE node, exposed at `https://infisical.nomad.opsc.io`. Deployed 2026-11-25.
SSO is intentionally **not** configured yet (see §9 TODO); access uses a local
admin account.

## 1. Topology

```text
client ──TLS──> Traefik (CT 104, 10.20.10.13:443)
                 │  dynamic/infisical.yml   Host(`infisical.nomad.opsc.io`)
                 ▼
            Infisical core (CT 109, 10.20.10.22:8080, native package)
                 ├── PostgreSQL 17.12  (127.0.0.1:5432, db/user `infisical`)
                 └── Redis 8.0.2       (127.0.0.1:6379)

DNS: Technitium (CT 102, 10.20.10.11) zone nomad.opsc.io
     infisical.nomad.opsc.io A 10.20.10.13  TTL 300
```

| Item | Value |
| --- | --- |
| Host access | `ssh -o StrictHostKeyChecking=no -i ~/.ssh/dsh root@control.nomad.opsc.io` |
| Container | CT 109 `infisical`, Debian 13.1, unprivileged, `nesting=1`, `onboot=1` |
| Resources | 2 vCPU / 4096 MB RAM / 1024 MB swap / 20 GB disk (`local-lvm`) |
| Guest IP | **10.20.10.22/24**, gw 10.20.10.1, DNS 10.20.10.11 |
| App listener | `0.0.0.0:8080` (`HOST=0.0.0.0`), package `infisical-core 0.167.15-1` |
| Public URL | `https://infisical.nomad.opsc.io` (TLS terminated by Traefik) |
| Project | `dsh-infra` (`3d4d76eb-3d82-479e-a9c2-5827b9821489`), env `prod` |
| Organisation | `Nomad` (`a08c8062-8345-47c5-9063-7f961a57eac9`) |

> **Address note.** The original plan said "DNS → CT 109's IP". That cannot work:
> TLS termination and host routing live on Traefik (CT 104). The record therefore
> points at Traefik (10.20.10.13), exactly like `dsh`, `docmost` and `native`.
> CT 109's real address (10.20.10.22) appears only inside the Traefik upstream.

## 2. Install steps actually used

Everything below ran through `pct exec 109` on the control node.

```bash
# container (created on the PVE node)
pct create 109 local:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst \
  --hostname infisical --cores 2 --memory 4096 --swap 1024 --rootfs local-lvm:20 \
  --net0 name=eth0,bridge=vmbr0,ip=10.20.10.22/24,gw=10.20.10.1,type=veth \
  --nameserver 10.20.10.11 --unprivileged 1 --features nesting=1 --onboot 1

# dependencies
apt-get update && apt-get install -y postgresql redis-server curl ca-certificates \
  openssl gnupg lsb-release jq
systemctl enable --now postgresql redis-server

# database (password generated on the guest, stored in /root/.infisical-bootstrap)
su - postgres -c "psql -c \"CREATE ROLE infisical LOGIN PASSWORD '<generated>'\""
su - postgres -c "createdb -O infisical infisical"

# Infisical native package (current Oct-2025 flow)
curl -1sLf 'https://artifacts-infisical-core.infisical.com/setup.deb.sh' | bash
apt-get update && apt-get install -y infisical-core
```

`/etc/infisical/infisical.rb` (root, 0600) — rendered by `infisical-ctl reconfigure`
into `/opt/infisical-core/etc/infisical_core/env/`:

```ruby
infisical_core['ENCRYPTION_KEY']  = '<32 hex chars>'
infisical_core['AUTH_SECRET']     = '<base64>'
infisical_core['DB_CONNECTION_URI'] = 'postgres://infisical:<pw>@127.0.0.1:5432/infisical'
infisical_core['REDIS_URL']       = 'redis://127.0.0.1:6379'
infisical_core['HOST']            = '0.0.0.0'   # required: default binds 127.0.0.1
```

```bash
infisical-ctl reconfigure     # renders config + (re)starts the runit service
infisical-ctl status
```

Service supervision: `infisical-runsvdir.service` (runit),
`systemctl is-enabled` = `enabled`, `is-active` = `active`.

### First admin (SSO out of scope)

```bash
# inside CT 109; organisation is created in the same call
curl -sS -X POST http://127.0.0.1:8080/api/v1/admin/bootstrap \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@nomad.opsc.io","password":"<generated>","organization":"Nomad"}'
# -> 200, returns user + organisation + an admin machine identity token
```

The bootstrap response contains a machine-identity token (org-admin scope). It is
kept at `/root/.infisical-identity-token` (0600) inside CT 109 and was used for
the API-driven secret migration; the human admin logs in with email/password.

## 3. DNS wiring (Technitium, CT 102)

The zone is stored in Technitium's binary format, so the HTTP API is used, not the
zone file. A permanent token exists at `/root/technitium.token` (0600) on control.

```bash
T=$(cat /root/technitium.token)
curl -sS "http://10.20.10.11:5380/api/zones/records/add?token=$T\
&domain=infisical.nomad.opsc.io&type=A&ipAddress=10.20.10.13&ttl=300"
dig +short infisical.nomad.opsc.io @10.20.10.11   # -> 10.20.10.13
```

Note: the API `records/update` endpoint rejects an update without the old value;
delete + add was used to change the target while diagnosing the IP conflict (§10).

Control host resolver: `/etc/resolv.conf` had only `nameserver 10.20.10.1`, which
does not serve the zone, so CLI verification could not resolve any
`*.nomad.opsc.io` name. `nameserver 10.20.10.11` was prepended (backup:
`/etc/resolv.conf.bak-infisical`). Revert with
`cp /etc/resolv.conf.bak-infisical /etc/resolv.conf`.

## 4. Traefik wiring (CT 104)

File: `/etc/traefik/dynamic/infisical.yml` (file provider watches the directory;
no restart needed). Mirrors `dsh.yml`, inherits the `secure-headers` middleware
defined there and the `*.nomad.opsc.io` wildcard certificate via `tls: {}`.

```yaml
http:
  routers:
    infisical:
      rule: Host(`infisical.nomad.opsc.io`)
      entryPoints: [websecure]
      service: infisical
      middlewares: [secure-headers]
      tls: {}
  services:
    infisical:
      loadBalancer:
        passHostHeader: true
        servers:
          - url: http://10.20.10.22:8080
```

## 5. Secret inventory and locations

`dsh-infra` → environment `prod`, one folder per source. **37 secrets**, all
verified byte-identical to their sources (SHA-256 comparison of decrypted values).

| Folder | Secrets | Source (still authoritative) |
| --- | --- | --- |
| `/studio` | `UNSLOTH_LARGE_API_KEY`, `STUDIO_KEY` | CT 103 `/etc/dsh/llm.env`; control `/root/.studio.key` |
| `/cognee` | `COGNEE_API_KEY`, `COGNEE_BASE_URL`, `COGNEE_MEMORY_SETTINGS_TOKEN` | CT 103 `/etc/dsh/cognee.env` |
| `/varad` | `COGNEE_API_KEY`, `COGNEE_BASE_URL`, `COGNEE_MEMORY_SETTINGS_TOKEN`, `COGNEE_SUMMARY_BASE_URL`, `UNSLOTH_LARGE_API_KEY` | CT 103 `/etc/dsh-varad/varad.env` |
| `/cognee-stack` | 27 keys: `DB_*`, `VECTOR_DB_*`, `LLM_*`, `EMBEDDING_*`, `FASTAPI_USERS_JWT_SECRET`, `DEFAULT_USER_PASSWORD`, `CORS_ALLOWED_ORIGINS`, `REQUIRE_AUTHENTICATION`, `ENABLE_BACKEND_ACCESS_CONTROL` | CT 106 `/opt/stacks/cognee/.env` |

Migration method: admin identity token → `POST /api/v4/secrets/<NAME>`
(`projectId`, `environment=prod`, `secretPath=/<folder>`, `type=shared`); folders
created first with `POST /api/v2/folders`. Script:
`/root/migrate_infisical.py` on control; summary
`/root/infisical-migration-summary.json`.

**The env files were not modified** (pre/post `sha256sum` identical) and remain
authoritative until each consumer is cut over and verified. Nothing was pointed at
Infisical as part of this deployment.

Machine-readable copy of this inventory lives in the summary JSON; the migration
is idempotent (re-running creates missing keys and PATCHes existing ones).

## 6. Credentials and key material (locations only)

| What | Where | Mode |
| --- | --- | --- |
| Infisical admin URL/email/password + DB password | **control:`/root/infisical-admin`** | 0600 |
| DB password, `ENCRYPTION_KEY`, `AUTH_SECRET`, admin password | CT 109:`/root/.infisical-bootstrap` | 0600 |
| Rendered runtime env (DB URI, keys) | CT 109:`/opt/infisical-core/etc/infisical_core/env/` | root |
| Org-admin machine identity token | CT 109:`/root/.infisical-identity-token` | 0600 |
| Technitium API token | control:`/root/technitium.token` | 0600 |

`ENCRYPTION_KEY` is the root of all stored ciphertext. Losing it makes every
secret in the project unrecoverable even with a database dump.

## 7. Verification evidence (run from control host)

```text
systemctl is-enabled infisical-runsvdir postgresql redis-server -> enabled enabled enabled
systemctl is-active  infisical-runsvdir postgresql redis-server -> active  active  active
curl -I https://infisical.nomad.opsc.io                -> HTTP/2 200
curl    https://infisical.nomad.opsc.io/api/status     -> 200
curl    https://infisical.nomad.opsc.io/login          -> 200
getent hosts infisical.nomad.opsc.io                   -> 10.20.10.13
value integrity: checked=37 bad=0 ; sources_unchanged=True
```

## 8. Backup and restore

**Backup (inside CT 109, root):**

```bash
mkdir -p /var/backups/infisical
pg_dump -h 127.0.0.1 -U infisical -Fc infisical > /var/backups/infisical/db-$(date +%F).dump
tar czf /var/backups/infisical/config-$(date +%F).tgz \
  /etc/infisical/infisical.rb /opt/infisical-core/etc/infisical_core/env
```

Copy both files off the container (they contain the encryption key and DB URI, so
treat the archive as top-secret). Keep at least the last 7 daily dumps.

**Restore into a fresh container:**

1. Recreate CT 109 with the same spec and IP, install `postgresql` and
   `infisical-core` (§2), stop the service: `systemctl stop infisical-runsvdir`.
2. Restore config first (`/etc/infisical/infisical.rb`, env dir) — the DB password
   and keys must match the dump.
3. `su - postgres -c "dropdb --if-exists infisical; createdb -O infisical infisical"`
   then `pg_restore -h 127.0.0.1 -U infisical -d infisical db-YYYY-MM-DD.dump`.
4. `infisical-ctl reconfigure`; verify `/api/status` = 200 and log in with the
   admin account from `/root/infisical-admin` (or the value in
   `/root/.infisical-bootstrap` if the file was restored).
5. Re-point Traefik/DNS only if the address changed.

## 9. TODO — SSO (out of scope now)

- Authentik is remote at `sso.opsc.io`; it will be wired to Infisical later.
- Planned: create an OIDC application/provider in Authentik for Infisical, then set
  `infisical_core['OIDC_*']` (`OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`,
  `OIDC_CONFIGURATION_URL`, `OIDC_ALLOWED_EMAILS` as needed) in
  `/etc/infisical/infisical.rb`, `infisical-ctl reconfigure`, and verify login with
  a test user before enforcing SSO. Keep the local admin as break-glass.
- Do not remove the local admin account until SSO login is proven from outside the
  LAN.

## 10. IP conflict during deployment (fixed)

The first address chosen, `10.20.10.21`, was silently in use by CT `2001` on node
`aimid` (SeaweedFS) — it does not answer ICMP but does answer ARP, so the initial
ping scan reported it free. Symptom: `https://infisical.nomad.opsc.io` returned
`400` with `server: SeaweedFS Volume` and the backend was unreachable on
`10.20.10.21:8080`. CT 109 was re-addressed to **10.20.10.22** (free cluster-wide:
`.22`/`.23` are in no LXC/VM config and have no ARP entry); Traefik upstream and
all verification were redone. Lesson: confirm free addresses with ARP/MAC checks
and a cluster-wide config grep, not ping alone.

## 11. Rollback

Nothing outside CT 109 depends on Infisical yet, and source env files are untouched,
so rollback is non-destructive to dsh/cognee:

```bash
# 1. stop exposure (Traefik picks this up immediately, no restart)
pct exec 104 -- rm /etc/traefik/dynamic/infisical.yml

# 2. remove DNS record
T=$(cat /root/technitium.token)
curl -sS "http://10.20.10.11:5380/api/zones/records/delete?token=$T\
&domain=infisical.nomad.opsc.io&type=A&ipAddress=10.20.10.13"

# 3. stop the service (keep data) or destroy the container (loses data)
pct exec 109 -- systemctl disable --now infisical-runsvdir
pct stop 109            # keep for inspection
# pct destroy 109       # destructive: also removes the 20 GB volume

# 4. optional: revert control-host resolver change
cp /etc/resolv.conf.bak-infisical /etc/resolv.conf
```

If a consumer is later cut over to Infisical, revert that consumer's env/secret
reference first, restart it, verify, and only then tear Infisical down.

## 12. Rotation procedure (once consumers are verified)

Current phase: env files remain authoritative. Rotate in this order so no consumer
ever sees a dead key:

1. Create the new credential at the provider (Unsloth/Cognee/etc.).
2. Write it to Infisical: UI (`dsh-infra` → `prod` → folder → secret) or
   `PATCH /api/v4/secrets/<NAME>` with
   `{projectId, environment:"prod", secretPath:"/<folder>", secretValue}` using the
   org-admin identity token.
3. Write the same value to the authoritative env file (CT 103 `/etc/dsh/*.env`,
   `/etc/dsh-varad/varad.env`, CT 106 `/opt/stacks/cognee/.env`).
4. Restart the consumer, verify health, then revoke the old credential at the provider.
5. Never rotate `ENCRYPTION_KEY` as part of a secret rotation; that is a separate
   re-encryption procedure (see Infisical "rotating the encryption key" docs).

## 13. Operational notes

- `infisical-ctl tail` follows app logs; `journalctl -u infisical-runsvdir` shows
  supervisor logs.
- `/api/status` is the health endpoint; use it for any monitoring.
- Do not edit files under `/opt/infisical-core/etc/infisical_core/env/` directly —
  edit `/etc/infisical/infisical.rb` then `infisical-ctl reconfigure`, otherwise
  the next reconfigure overwrites them.
- Package upgrades: `apt-get update && apt-get install --only-upgrade infisical-core`
  then `infisical-ctl reconfigure`. Take a DB dump first.
