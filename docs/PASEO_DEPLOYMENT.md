# PASEO — self-hosted coding-agent control plane (CT 2002 on aimid)

Deployment plan for **Paseo 0.17.4** at `paseo.nomad.opsc.io`, in a new LXC on the
`aimid` Proxmox node, exposing the daemon's own web UI through Traefik so browser and
phone clients work without the macOS app. Written 2026-11-25. **Research only — nothing
in this document has been executed.** No container, DNS record, Traefik file or firewall
rule was created; every cluster fact below is the output of a read-only command.

| Item | Value | Why |
| --- | --- | --- |
| PVE node | `aimid` (10.20.10.20) | required by the brief |
| Container | **CT 2002**, hostname `paseo`, unprivileged | lowest free `2xxx` id (evidence §3.1) |
| OS | Debian 13 (`debian-13-standard_13.6-1_amd64.tar.zst`) | the only Debian template installed on `local` |
| IP (primary) | **10.20.10.23/24**, gw 10.20.10.1, DNS 10.20.10.11 | ARP/ICMP-free from two nodes (§3.1) |
| IP (fallback) | **10.20.10.24/24** | same evidence; only if `.23` is claimed before we run |
| Resources | 4 vCPU, 8192 MB RAM, 2048 MB swap, 32 GB on `tank-lxc-infra` | sizing rationale in §3.2 (estimate, not a doc claim) |
| Workspace mount | host `/tank/workspace/paseo` → `/srv/workspace` | 5.46 TiB free on `tank`; repos must not live on the 32 GB rootfs |
| Ingress | Traefik CT 104, `paseo.nomad.opsc.io` → `http://10.20.10.23:6767` | mirrors `infisical.yml`/`seaweedfs.yml` |
| State | `/srv/paseo/.paseo` (PASEO_HOME) | config, keypair, logs, worktrees |
| Upstream | 0.17.4 (2026-11-23), Apache-2.0, `@getpaseo/cli` | npm registry + GitHub releases |

---

## 1. Verdict — native LXC, not Docker-in-LXC

Paseo's server half is a **headless Node daemon**; it does not need a GUI, X11 or
Electron, and it serves the browser UI itself. Docker is therefore an *option*, not a
requirement — the brief's "if it cannot run natively" trigger does not fire.

The lines that decide it:

> "**Server / CLI** — For headless machines, dev boxes, or any setup where you want the
> daemon running without the desktop UI: `npm install -g @getpaseo/cli` / `paseo`"
> — https://paseo.sh/docs.md

> "The official Paseo Docker image runs the daemon and serves the bundled browser UI from
> the same HTTP origin."
> — https://paseo.sh/docs/docker.md (i.e. the image and the CLI run *the same daemon*; the
> image adds packaging, not capability)

> "Paseo's daemon can serve the browser web app itself, from the same address it already
> uses for the API. You don't need the hosted app at app.paseo.sh"
> — https://paseo.sh/docs/web-ui.md

> "Server — Run the Paseo server anywhere, connect from any client — `npm install -g
> @getpaseo/cli && paseo`" (a first-class download category next to Desktop/Mobile/Web)
> — https://paseo.sh/download

What *is* GUI-only is the desktop app. The Linux artifacts on the release page are desktop
(GUI) installers — `Paseo-0.17.4-amd64.deb`, `Paseo-0.17.4-x86_64.rpm`,
`Paseo-x86_64.AppImage`, 116–171 MB, shipped with `latest-linux.yml` update metadata
alongside the repo's `packages/desktop` app shell — and are useless on a headless box;
that is not the path we take. — https://github.com/getpaseo/paseo/releases (assets for
`v0.17.4`, published 2026-11-23)

**Why native wins here, concretely:** the cluster already runs two non-Docker services
with this shape — SeaweedFS CT 2001 as five native systemd units
(`seaweedfs-master/filer/volume/s3/admin.service`) and Infisical CT 109 as a native
package under runit (`infisical-runsvdir.service`) — and native gives
one process tree, no Docker NAT, no `nesting`/`keyctl`, and file-level backup of
`/srv/paseo`. The Docker image buys us a pinned Node runtime and a tidy child image for
agent CLIs; both are reproducible natively with `nodesource` + `npm -g`, and the agent
CLIs are npm packages anyway (the image installs them the same way:
`RUN npm install -g @openai/codex @anthropic-ai/claude-code opencode-ai`
— https://paseo.sh/docs/docker.md). If T1 prefers the upstream-tested artifact over
convention, **Appendix B is a drop-in Docker-in-LXC variant** of the same topology on the
same VMID/IP/hostname; nothing else in this document changes except §3.3–§3.6.

---

## 2. Architecture as it would actually stand

### 2.1 The pieces, and who runs what

> "Paseo follows a client-server architecture, similar to Docker. The daemon runs on your
> machine and manages your coding agents. Clients (the mobile app, CLI, or web interface)
> connect to the daemon" — https://paseo.sh/docs/security.md

| Paseo piece | Runs where in this plan | Required for phone/browser use? |
| --- | --- | --- |
| **daemon** (agent supervisor + HTTP/WS + `/mcp`) | CT 2002, systemd, user `paseo` | **yes — this is the service** |
| **bundled web UI** (static, same origin) | served by that daemon on `:6767` | yes, that's what the browser loads |
| desktop app (GUI shell in `packages/desktop`) | *not installed*; optional Mac client | no |
| mobile app (iOS/Android) | user's phone | no (browser works) |
| **relay** (`getpaseo/paseo-relay`, Elixir) | **not used**; optional outbound tunnel | no — we use direct HTTPS |
| **Hub** (`@getpaseo/hub`, triggers from GitHub/Slack) | not in this plan (separate service, §6) | no |

### 2.2 Topology

```
   phone browser / laptop browser              Mac desktop app (optional)
            │  HTTPS 443                              │  HTTPS 443
            │  (wildcard *.nomad.opsc.io cert)        │  "direct connection", SSL on
            ▼                                         ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ Traefik  CT 104  10.20.10.13            (Traefik v3.7.19)    │
   │  dynamic/paseo.yml:                                          │
   │    Host(`paseo.nomad.opsc.io`) → http://10.20.10.23:6767      │
   │    middlewares: [secure-headers]   tls: {}  (no ACME work)   │
   └───────────────────────────┬──────────────────────────────────┘
                               │  plain HTTP + WebSocket upgrade
                               │  Host + X-Forwarded-Proto preserved
                               ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ CT 2002 "paseo" on aimid            10.20.10.23              │
   │  systemd: paseo.service  →  `paseo daemon run`  (user paseo) │
   │    :6767  /            static web UI   (no auth, by design)  │
   │           /api/*       REST            (Bearer password)     │
   │           /ws          WebSocket       (password)            │
   │           /mcp/*       Paseo MCP server for agents           │
   │    supervisor ──► worker ──► agent CLIs on PATH:             │
   │                              claude · codex · opencode · …   │
   │  /srv/paseo/.paseo     config.json, daemon-keypair.json, log │
   │  /srv/workspace        ← bind mount /tank/workspace/paseo    │
   └───────────────────────────┬──────────────────────────────────┘
                               │ egress open (model APIs, npm, git)
                               ▼
                     api.anthropic.com · chatgpt.com · registry.npmjs.org
                     (later, optional) Cognee MCP 10.20.10.15 · relay
```

### 2.3 The "is the Linux box just a worker?" question — answered plainly

**No. The Linux box is a full endpoint, not a worker the Mac dials into.** The daemon
serves the UI and API from one origin:

> "The page is served from the same origin as the daemon's API and WebSocket. When you
> open it, the app automatically connects back to that same origin" — https://paseo.sh/docs/web-ui.md

So the honest topology is: **Traefik → daemon on CT 2002, and that is the whole product**
for browser and phone. The Mac app is optional and, if used, is a *peer client* (it can
add this daemon as a host) rather than the owner of state.

Multi-machine is a flat model: every machine runs its own daemon and a client may hold
several hosts ("Settings → Add host"; `paseo --host …`). Transport options are the
E2E-encrypted relay, direct TCP, SSH, or Tailscale:

> "Clients connect to the daemon over WebSocket. There are two ways … **Relay
> connection** … **Direct connection**" — https://paseo.sh/docs/security.md

> "SSH transport connects to an existing daemon through your local OpenSSH client."
> — https://paseo.sh/docs/connectivity.md

We take the **direct** path over Traefik (no relay, no QR pairing, no SaaS dependency),
which the docs support explicitly:

> "**Public reverse proxy or tunnel.** Expose the UI on a domain over HTTPS, terminating
> TLS at a reverse proxy or a tunnel. This is the full self-hosted setup."
> — https://paseo.sh/docs/web-ui.md

Three daemon settings make a non-loopback proxy work, and all three are mandatory:

1. `PASEO_HOSTNAMES=paseo.nomad.opsc.io` — otherwise `403 Invalid Host header`:
   > "Paseo uses a host allowlist to validate the `Host` header… Default (`[]`): allow
   > `localhost`, `*.localhost`, and all IP addresses" — https://paseo.sh/docs/security.md
2. `PASEO_TRUSTED_PROXIES=10.20.10.13` — Traefik is *not* loopback:
   > "The daemon trusts forwarded headers from loopback proxies by default… If your proxy
   > reaches the daemon from another address … configure the trusted proxy ranges"
   > — https://paseo.sh/docs/web-ui.md
3. `PASEO_PASSWORD` — password auth is the access control:
   > "When a password is configured, all HTTP requests must include an `Authorization:
   > Bearer <password>` header, and every WebSocket client … must send the password"
   > — https://paseo.sh/docs/security.md

---

## 3. Step-by-step plan

Run steps on the owning node (`aimid` = `ssh root@10.20.10.20`) unless a step says
`control`. House style mirrors `docs/INFISICAL.md` and `docs/SEAWEEDFS.md`.

### 3.1 Pre-flight — prove the VMID and the IP are free

```bash
# on aimid
pct list; qm list
# on control
cat /etc/pve/.vmlist
```

Observed (2026-11-25):

```
# aimid
VMID       Status     Lock         Name
120        running                 unsloth
2001       running                 seaweedfs

# control: pct list → 101 nomad-control, 102 technitium, 103 dsh, 104 traefik,
#                       105 docker, 106 cognee, 107 hermes, 108 native, 109 infisical
# /etc/pve/.vmlist ids: 104, 500(aismall qemu), 103, 200(ailarge), 102, 108, 101,
#                       120(aimid), 107, 106, 105, 2001(aimid), 109
```

→ **2002 is free cluster-wide**: `.vmlist` is the authoritative id registry, and it holds
no `2000` and nothing in `2002`–`2099`. The only `2xxx` ids in use are `200` (a container
on `ailarge`, a different node anyway) and `2001` (`aimid`); Proxmox would refuse a
duplicate id in any case. `pvesh get /cluster/resources --type vm` agrees on the guests it
reported (101–109 and `120` on `control`, `200` on `ailarge`).

IP evidence — this subnet has bitten us before, so ICMP alone is not accepted:

```bash
# on control (10.20.10.10) AND on aimid (10.20.10.20)
for i in $(seq 1 254); do (ping -c1 -W1 10.20.10.$i >/dev/null 2>&1 && echo 10.20.10.$i) & done; wait
```

Both nodes returned the identical live set:

```
10.20.10.1 10.20.10.10 10.20.10.11 10.20.10.12 10.20.10.13 10.20.10.14
10.20.10.15 10.20.10.16 10.20.10.17 10.20.10.20 10.20.10.21 10.20.10.22
10.20.10.30 10.20.10.40 10.20.10.60 10.20.10.101 10.20.10.110 10.20.10.196
```

ARP-level check (the decisive one — `10.20.10.21` was once "free" by ping and live by ARP,
see `docs/INFISICAL.md` §10):

```bash
for ip in 10.20.10.23 10.20.10.24 10.20.10.22; do
  ip neigh flush $ip 2>/dev/null; ping -c3 -W1 $ip >/dev/null 2>&1
  echo -n "$ip ping=$? | "; ip neigh show $ip | head -1
done
```

```
# control
10.20.10.23 ping=1 | 10.20.10.23 dev vmbr0 INCOMPLETE
10.20.10.24 ping=1 | 10.20.10.24 dev vmbr0 INCOMPLETE
10.20.10.22 ping=0 | 10.20.10.22 dev vmbr0 lladdr bc:24:11:a7:01:82 REACHABLE   ← infisical, control
# aimid
10.20.10.23 ping=1 | 10.20.10.23 dev vmbr0 INCOMPLETE
10.20.10.24 ping=1 | 10.20.10.24 dev vmbr0 INCOMPLETE
10.20.10.21 ping=0 | 10.20.10.21 dev vmbr0 lladdr bc:24:11:2e:aa:01 REACHABLE   ← CT 2001, matches pct config 2001 hwaddr
```

`INCOMPLETE` = the kernel sent ARP and got no answer, from two different nodes — that is
L2 evidence, not just missing ICMP. Supporting checks:

```bash
dig +short -x 10.20.10.23 @10.20.10.11      # (empty)
dig +short -x 10.20.10.24 @10.20.10.11      # (empty)
dig +short paseo.nomad.opsc.io @10.20.10.11 # (empty)
T=$(cat /root/technitium.token)
curl -s "http://10.20.10.11:5380/api/dhcp/scopes/list?token=$T"
# {"response":{"scopes":[{"name":"Default","enabled":false,"startingAddress":"192.168.1.1",…
```

No reverse zone exists (all `dig -x` empty), Technitium's only DHCP scope is **disabled**
and on `192.168.1.0/24`, so nothing in this subnet can hand `.23`/`.24` to someone else
behind our back. (The router at `10.20.10.1` is not inspectable from here — see §6.)

**Decision: use `10.20.10.23`; if ARP shows it taken at execution time, use `10.20.10.24`
and change only two places (§3.10 upstream, §3.1 `pct create --net0`).**

### 3.2 Create the container

```bash
# on aimid
pct create 2002 local:vztmpl/debian-13-standard_13.6-1_amd64.tar.zst \
  --hostname paseo --cores 4 --memory 8192 --swap 2048 --rootfs tank-lxc-infra:32 \
  --net0 name=eth0,bridge=vmbr0,ip=10.20.10.23/24,gw=10.20.10.1,type=veth \
  --nameserver 10.20.10.11 --unprivileged 1 --features nesting=1 --onboot 1 \
  --tags paseo,agents \
  --description "Paseo daemon + bundled web UI (CT 2002, aimid)"

pct start 2002 && pct exec 2002 -- ip -4 addr show eth0
```

Template and storage are what the node actually has:

```
# pveam list local
local:vztmpl/debian-13-standard_13.6-1_amd64.tar.zst   123.93MB
local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst 135.03MB
# pvesm status
tank-lxc-infra  zfspool  active  5880264784 KiB total  …  0.23% used
```

Sizing is an **estimate, not a documented requirement**: the daemon is one Node process
(~300–500 MB), but every agent session is another CLI process tree (Claude Code/Codex
typically 300–900 MB each), and the stated goal is *several fleets in parallel*. 4 vCPU /
8 GB is the floor for 3–5 concurrent agents; 32 GB rootfs holds Node + CLI global
packages, with repos on the bind mount:

```bash
# on aimid
mkdir -p /tank/workspace/paseo
chown 100000:100000 /tank/workspace/paseo      # unprivileged root mapping, as CT 2001 did
pct set 2002 -mp0 /tank/workspace/paseo,mp=/srv/workspace
pct exec 2002 -- df -h /srv/workspace
```

Verified by the configs we mirror — `pct config 2001`:

```
cores: 2 / memory: 4096 / swap: 1024 / rootfs: tank-lxc-infra:subvol-2001-disk-0,size=16G
features: nesting=1 / unprivileged: 1 / onboot: 1 / nameserver: 10.20.10.11
net0: name=eth0,bridge=vmbr0,gw=10.20.10.1,ip=10.20.10.21/24,type=veth
```

**Verification:** `pct status 2002` → `running`; `pct exec 2002 -- ping -c2 10.20.10.11`
replies; `pct exec 2002 -- dig +short dsh.nomad.opsc.io @10.20.10.11` returns `10.20.10.13`
(the zone has no apex `A` record — only `NS`/`SOA` — so query a service name, not the apex).

`nesting=1` is kept for convention (CT 109 has it too); it is **not** needed for a native
service — it becomes mandatory together with `keyctl=1` only in the Docker variant
(`pct config 106`: `features: nesting=1,keyctl=1`).

### 3.3 Base packages + Node 22

Debian 13 ships Node 20, which is *not* what upstream builds against, so install 22:

```bash
pct exec 2002 -- bash -lc '
  apt-get update && apt-get install -y curl ca-certificates gnupg git openssh-client procps lbzip2 jq sudo
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
  node -v && npm -v'
```

Evidence that these are the deps the daemon actually expects — the official image
installs exactly this set (`docker/base/Dockerfile`):

```
apt-get install -y --no-install-recommends bash ca-certificates curl git gosu lbzip2 \
  openssh-client procps tini
```

and pins the runtime:

```
ARG NODE_IMAGE=node:22-bookworm-slim
```

— https://github.com/getpaseo/paseo/blob/main/docker/base/Dockerfile

Debian 13's own candidate is lower, which is why NodeSource is needed:

```
# pct exec 2001 -- apt-cache policy nodejs
  Installed: (none)
  Candidate: 20.19.2+dfsg-1+deb13u3
```

**Verification:** `node -v` → `v22.x`; `git --version`; `ssh -V`.

### 3.4 Service user, install Paseo, agent CLIs

```bash
pct exec 2002 -- bash -lc '
  useradd --create-home --home-dir /srv/paseo --shell /bin/bash paseo
  install -d -o paseo -g paseo /srv/paseo/.paseo /srv/paseo/.claude /srv/paseo/.codex \
      /srv/paseo/.config /srv/paseo/.local/share /srv/paseo/.local/state /srv/paseo/.cache
  npm install -g @getpaseo/cli@0.17.4
  npm install -g @anthropic-ai/claude-code @openai/codex
  paseo --version'
```

Global bins land in `/usr/bin`, so the `paseo` user (and the agents it spawns) find them
without a PATH hunk. Version pinning matters: the CLI is 0.17.4, matching the 0.17.4
desktop/mobile release, and the daemon's own docs say the bundled UI always matches its
daemon ("The web app ships inside the daemon package, so the UI you serve always matches
your daemon version" — https://paseo.sh/docs/web-ui.md).

Which CLIs Paseo looks for — from the supported list (`claude`, `codex`, `copilot`,
`opencode`, `pi`, `muse`, `agy`, `fx`, `hoplite`, `omp`, plus any ACP agent):

> "Paseo ships an integration for each of these agents. Most appear in Paseo
> automatically after you install and sign in to the CLI." — https://paseo.sh/docs/supported-providers.md

> "The image does not bundle agent CLIs such as Claude Code, Codex, OpenCode, Copilot, Pi,
> or Muse Code." — https://paseo.sh/docs/docker.md

Sign each one in **as the `paseo` user**, so credentials land in `/srv/paseo`:

```bash
pct exec 2002 -- su - paseo -c 'claude'     # interactive login
pct exec 2002 -- su - paseo -c 'codex login'
```

**Verification:** `pct exec 2002 -- su - paseo -c 'paseo --version'`; `ls -la /srv/paseo/.claude`.

### 3.5 Password + daemon configuration

Set the password (bcrypt, stored in `config.json`, never plaintext):

```bash
pct exec 2002 -- su - paseo -c 'PASEO_HOME=/srv/paseo/.paseo paseo daemon set-password'
```

> "This prompts for a password, writes the bcrypt hash to `config.json`, and tells you to
> restart the daemon." — https://paseo.sh/docs/configuration.md

Then write the config file (or rely on the unit's environment — the unit below does both,
file for hostnames/CORS, env for listen/UI/proxies):

```json
{
  "$schema": "https://paseo.sh/schemas/paseo.config.v1.json",
  "version": 1,
  "daemon": {
    "listen": "0.0.0.0:6767",
    "hostnames": ["paseo.nomad.opsc.io"],
    "trustedProxies": ["10.20.10.13"]
  },
  "features": { "webUi": { "enabled": true } }
}
```

**Verification:** `jq '.daemon' /srv/paseo/.paseo/config.json`; the `password` field is a
`$2b$…` hash, and `daemon-keypair.json` is mode `0600` (it appears after first start).

### 3.6 systemd unit

`/etc/systemd/system/paseo.service`:

```ini
[Unit]
Description=Paseo daemon (agents + bundled web UI) on CT 2002
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=paseo
Group=paseo
Environment=HOME=/srv/paseo
Environment=PASEO_HOME=/srv/paseo/.paseo
Environment=PASEO_LISTEN=0.0.0.0:6767
Environment=PASEO_WEB_UI_ENABLED=true
Environment=PASEO_HOSTNAMES=paseo.nomad.opsc.io
Environment=PASEO_TRUSTED_PROXIES=10.20.10.13
Environment=PASEO_LOG_FORMAT=json
Environment=CLAUDE_CONFIG_DIR=/srv/paseo/.claude
Environment=CODEX_HOME=/srv/paseo/.codex
Environment=XDG_CONFIG_HOME=/srv/paseo/.config
Environment=XDG_DATA_HOME=/srv/paseo/.local/share
Environment=XDG_STATE_HOME=/srv/paseo/.local/state
Environment=XDG_CACHE_HOME=/srv/paseo/.cache
ExecStart=/usr/bin/paseo daemon run
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=30
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

`daemon run` (not `daemon start`) is the documented foreground deployment, so systemd owns
the supervisor:

> "Foreground deployments … `PASEO_LISTEN=127.0.0.1:6799 PASEO_RELAY_ENABLED=false paseo
> daemon run` … It stays attached until the supervisor exits or you cancel"
> — https://paseo.sh/docs/cli.md

The env names are all documented (`PASEO_HOME`, `PASEO_LISTEN`, `PASEO_HOSTNAMES`,
`PASEO_TRUSTED_PROXIES`, `PASEO_WEB_UI_ENABLED`, `PASEO_LOG_FORMAT`) —
https://paseo.sh/docs/configuration.md — and the variable set matches what the image
exports, so behaviour is identical to the container path
(`docker/base/rootfs/usr/local/bin/paseo-docker-entrypoint`).

```bash
pct exec 2002 -- bash -lc 'systemctl daemon-reload && systemctl enable --now paseo'
pct exec 2002 -- systemctl status paseo --no-pager
```

**Verification (inside the CT, before any proxy):**

```bash
pct exec 2002 -- curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:6767/          # 200 (static UI)
pct exec 2002 -- curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:6767/api/health # 200, the only exempt endpoint
pct exec 2002 -- curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:6767/ws         # 401 without the password
pct exec 2002 -- curl -sS -o /dev/null -w '%{http_code}\n' -H 'Host: evil.example.com' http://127.0.0.1:6767/  # 403
```

The last one is the DNS-rebinding allowlist doing its job
(https://paseo.sh/docs/security.md), and it is exactly why `PASEO_HOSTNAMES` must be set
before Traefik is pointed at the daemon.

### 3.7 Firewall inside the guest (nftables)

The cluster convention is a guest-owned default-deny table, because the PVE firewall is
off. Observed:

```
# pve-firewall status
Status: disabled/running
# ls /etc/pve/firewall/    → (empty)
```

`/etc/nftables.conf` on CT 2002 — mirrors CT 103 line for line, with the port changed:

```
#!/usr/sbin/nft -f
# Default-deny ingress for CT 2002 (paseo). Only Traefik may reach the daemon.
flush ruleset

table inet paseo_filter {
  chain input {
    type filter hook input priority filter; policy drop;

    iif lo accept
    ct state established,related accept
    ct state invalid drop

    # diagnostics from the LAN only
    ip protocol icmp icmp type echo-request ip saddr 10.20.10.0/24 accept

    # the only published service: Paseo plain HTTP + WebSocket, Traefik only
    ip protocol tcp tcp dport 6767 ip saddr 10.20.10.13 accept

    ip6 nexthdr ipv6-icmp ip6 saddr fe80::/10 accept

    limit rate 5/minute log prefix "paseo-input-drop: " level info
    counter drop
  }

  chain forward { type filter hook forward priority filter; policy drop; }
  chain output  { type filter hook output  priority filter; policy accept; }
}
```

```bash
pct exec 2002 -- bash -lc 'systemctl enable --now nftables && nft list ruleset'
```

CT 103's own file documents the pattern (`/etc/nftables.conf`, enabled:
`systemctl is-enabled nftables` → `enabled`; rules `policy drop`, only
`tcp dport 3080/3081 ip saddr 10.20.10.13 accept`).

**Verification:** from `control` (10.20.10.10) `curl -m3 http://10.20.10.23:6767/api/health`
must **time out / be refused**; from CT 104 it must return `200`.

### 3.8 Traefik route (no restart, no certificate work)

`/etc/traefik/dynamic/paseo.yml` on **CT 104** (write via `pct exec 104 -- tee`):

```yaml
# /etc/traefik/dynamic/paseo.yml — file-provider route for CT 2002 (Paseo, aimid 10.20.10.23).
# Paseo's daemon serves its own web UI + API + /ws on plain HTTP :6767; Traefik terminates TLS.
# tls: {} inherits the *.nomad.opsc.io wildcard from the ACME store — no per-service cert.
# passHostHeader must stay true: Paseo's Host allowlist (DNS-rebinding protection) and its
# wss:// origin both derive from the original Host header.
http:
  routers:
    paseo:
      rule: Host(`paseo.nomad.opsc.io`)
      entryPoints: [websecure]
      service: paseo
      middlewares: [secure-headers]
      tls: {}

  services:
    paseo:
      loadBalancer:
        passHostHeader: true
        servers:
          - url: http://10.20.10.23:6767
```

Why this exact shape (verified against the live config):

* `secure-headers` is defined once in `dsh.yml` and referenced from `infisical.yml` /
  `seaweedfs.yml` without redefinition — the file provider merges all files into one
  namespace, so referencing it from `paseo.yml` is the established pattern.
* `tls: {}` is all that's needed: a wildcard is issued by the `zone-apex` router in
  `acme-wildcard.yml` (`sans: ["*.nomad.opsc.io"]`, `certResolver: le`), and
  `traefik.yml` has `providers.file.directory: /etc/traefik/dynamic`, `watch: true`.
* `secure-headers` already sets `X-Forwarded-Proto: https` via `customRequestHeaders`,
  which is what Paseo needs to emit `wss://` ("the proxy passes `X-Forwarded-Proto: https`,
  the app automatically connects back over `wss://`" — https://paseo.sh/docs/web-ui.md).
* **No WebSocket-specific config is required.** Traefik v3 forwards the `Upgrade`
  hop-by-hop headers on any router, and this Traefik already carries long-lived streams
  for dsh (`/etc/nftables.conf` on 103 notes "/plugins/events is an anonymous SSE
  endpoint" served through this same proxy). No `buffering` middleware exists anywhere in
  `/etc/traefik/dynamic`, so responses are not buffered — which satisfies Paseo's
  "Not buffer responses" requirement.
* **No `basicAuth` middleware** — deliberately. The phone app authenticates with Paseo's
  own Bearer password; a second HTTP auth layer would break it. (The `seaweed-auth`
  basicAuth pattern in `seaweedfs.yml` stays confined to SeaweedFS.) See §5.

**Verification:**

```bash
# on CT 104 — the file provider reloads on write; a YAML error rejects only this file
pct exec 104 -- ls -l /etc/traefik/dynamic/paseo.yml
pct exec 104 -- journalctl -u traefik -n 30 --no-pager     # no "error while parsing" line
pct exec 104 -- grep paseo /var/log/traefik/access.log | tail -5   # after the first request
```

(There is no `/var/log/traefik/traefik.log` on this guest — only `access.log` plus the
journal; verified by `ls -la /var/log/traefik`.)

### 3.9 DNS record (Technitium, CT 102)

Mirrors `docs/INFISICAL.md` §3 exactly — same token file, same API, same TTL 300, same
target (`.13`, the Traefik guest):

```bash
# on control
T=$(cat /root/technitium.token)
curl -sS "http://10.20.10.11:5380/api/zones/records/add?token=$T\
&domain=paseo.nomad.opsc.io&zone=nomad.opsc.io&type=A&ipAddress=10.20.10.13&ttl=300"
dig +short paseo.nomad.opsc.io @10.20.10.11      # -> 10.20.10.13
```

`paseo.nomad.opsc.io` is single-label under the zone, so the wildcard cert covers it — the
same convention every other service uses (observed zone dump: `dsh`, `infisical`,
`seaweed`, `s3-seaweed`, `admin-seaweed`, `docmost`, `native` → all `A 10.20.10.13`,
`ttl=300`; `technitium`, `control`, `ai-mid`, `ai-large`, `ai-small`,
`nomad-control` → their own hosts).

**Verification:** `dig +short paseo.nomad.opsc.io @10.20.10.11` → `10.20.10.13`; and from
a client `curl -sS -o /dev/null -w '%{http_code}\n' https://paseo.nomad.opsc.io/`.

### 3.10 End-to-end verification matrix

| # | Check | Command | Expected |
| --- | --- | --- | --- |
| 1 | daemon up | `pct exec 2002 -- systemctl is-active paseo` | `active` |
| 2 | health through proxy | `curl -sS https://paseo.nomad.opsc.io/api/health` | `200` (exempt from auth by design) |
| 3 | UI served | `curl -sS -o /dev/null -w '%{http_code}' https://paseo.nomad.opsc.io/` | `200` (static files load pre-auth) |
| 4 | API gated | `curl -sS -o /dev/null -w '%{http_code}' https://paseo.nomad.opsc.io/ws` | `401` |
| 5 | auth works | `curl -sS -H "Authorization: Bearer $PW" -o /dev/null -w '%{http_code}' https://paseo.nomad.opsc.io/ws` | `101`/`200`, not `401` |
| 6 | WS upgrade survives proxy | `curl -si -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H "Authorization: Bearer $PW" https://paseo.nomad.opsc.io/ws \| head -1` | `HTTP/1.1 101 Switching Protocols` |
| 7 | Host fence on | `pct exec 2002 -- curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example.com' http://127.0.0.1:6767/` | `403` |
| 8 | guest firewall on | `curl -m3 http://10.20.10.23:6767/api/health` (from control, .10) | timeout/refused |
| 9 | agent visible | in the web UI: provider list shows `claude`/`codex` as installed | two providers |
| 10 | restart survives | `pct reboot 2002; sleep 45; curl -sS …/api/health` | `200` |

Check 6 is the one that matters for the browser/phone: Paseo streams agent output over
`/ws` and "without upgrade support the UI loads but never connects"
— https://paseo.sh/docs/web-ui.md.

### 3.11 Backups (currently **not** covered)

The only vzdump job today covers three control-node guests:

```
# cat /etc/pve/jobs.cfg
vzdump: cc011a0f-…
	comment dsh (103) + traefik (104) + docker (105)
	vmid 103,104,105
	schedule sun 03:30
```

`2002` is therefore **unbacked-up** until someone either adds it to a job or accepts that
`/srv/paseo` (small) plus `/tank/workspace/paseo` (large, git) are the only things worth
keeping. Minimum viable: a nightly `tar` of `/srv/paseo/.paseo` (`config.json`,
`daemon-keypair.json`, plugins, worktrees metadata) — the repos themselves are git.

---

## 4. Rollback — complete and ordered

```bash
# 1. stop exposure first (Traefik drops the router within seconds, no restart)
ssh root@control.nomad.opsc.io 'pct exec 104 -- rm -f /etc/traefik/dynamic/paseo.yml'

# 2. remove the DNS record (same API, delete form — see docs/INFISICAL.md §11)
ssh root@control.nomad.opsc.io 'T=$(cat /root/technitium.token); \
  curl -sS "http://10.20.10.11:5380/api/zones/records/delete?token=$T\
&domain=paseo.nomad.opsc.io&zone=nomad.opsc.io&type=A&ipAddress=10.20.10.13"'
dig +short paseo.nomad.opsc.io @10.20.10.11      # empty

# 3. stop the service, keep the data for inspection
ssh root@10.20.10.20 'pct exec 2002 -- systemctl disable --now paseo; pct stop 2002'

# 4. destroy (destructive: removes the 32 GB zvol; the bind mount survives)
ssh root@10.20.10.20 'pct destroy 2002'
#    then, only if the repos are not wanted:
#    rm -rf /tank/workspace/paseo
```

Nothing outside CT 2002 depends on Paseo, so rollback is non-destructive to dsh, Cognee,
Infisical or SeaweedFS. The only shared-surface edits are the two files in steps 1–2, both
additive and both removed by the commands above. If the *Docker* variant was used, add
`pct exec 2002 -- docker compose -f /opt/paseo/compose.yaml down -v` before step 3.

---

## 5. Security

### 5.1 What is exposed, and what protects it

| Surface | Reachable from | Protection |
| --- | --- | --- |
| `https://paseo.nomad.opsc.io/` (static UI) | anyone who can resolve the name and reach `.13:443` | **none, by design** — "The web app loads before authentication, by design" (https://paseo.sh/docs/web-ui.md) |
| `/api/*`, `/ws`, `/mcp/*` | same | Paseo password → `Authorization: Bearer …`, bcrypt hash in `config.json`, `401` otherwise (https://paseo.sh/docs/security.md) |
| `/api/health` | same | none — the documented liveness exemption |
| `10.20.10.23:6767` (raw daemon) | **Traefik only** | guest nftables `ip saddr 10.20.10.13` |
| TLS | — | wildcard `*.nomad.opsc.io` from the existing Let's Encrypt/Cloudflare-DNS resolver `le`; password auth "does not encrypt traffic", so TLS is not optional (https://paseo.sh/docs/web-ui.md) |

The public footprint is therefore: one hostname, one 443 listener, a login page, and a
Bearer-gated API. That is the *intended* self-hosted shape — the docs list it as the
"full self-hosted setup" topology, third of three in order of exposure.

### 5.2 What must never be exposed

* **Agent credentials** — `/srv/paseo/.claude`, `/srv/paseo/.codex`, `/srv/paseo/.config`.
  Upstream is explicit: "Treat `/home/paseo` as sensitive, it can contain daemon state and
  provider credentials" — https://paseo.sh/docs/security.md. Never bind-mount these into
  another container, never add them to a Traefik route, never `pct push` them around.
* **`daemon-keypair.json`** (mode `0600`) — the relay trust anchor; leaking it lets an
  attacker impersonate the daemon on the relay. We don't use the relay, but the file
  exists after first start.
* **`config.json`** — bcrypt hash + hostnames + CORS; keep `0600 paseo:paseo`.
* **Git/SSH material** in `/srv/paseo/.ssh` — if agents need push access, use a
  repo-scoped deploy key, not a personal key, because agents execute arbitrary code as
  `paseo` and a prompt-injected agent can read anything that user can read.
* **The Docker socket** — not present at all in the native plan (an argument for native:
  no `/var/run/docker.sock` inside an agent-executing guest). In the Docker variant, do
  **not** mount the host socket into the Paseo container.
* **No `basicAuth` on the Paseo route** — it would not add real safety (the app already
  has a password) and it *breaks* the mobile app, which cannot answer an HTTP Basic
  challenge. If a second layer is ever wanted, use Traefik `ipAllowList` for the
  LAN/VPN range instead, accepting that cellular access then needs Tailscale.

### 5.3 Firewall notes

* Host firewall is **off** (`pve-firewall status` → `disabled/running`, `/etc/pve/firewall/`
  empty), so guest-side nftables is the real control — exactly the reasoning recorded in
  CT 103's `/etc/nftables.conf` ("pve-firewall is disabled on the host and does not manage
  guest traffic, so the guest owns its own policy").
* CT 2002 therefore ships with the same default-deny `input` policy, ICMP echo from
  `10.20.10.0/24` for diagnostics, and a single allow: `6767` from `10.20.10.13`.
* Egress stays open (agents need model APIs, npm, git). That is a deliberate,
  documented trade-off in CT 103 as well.
* If the Mac desktop app should connect *directly* (bypassing Traefik), add one rule
  `ip saddr 10.20.10.0/24 tcp dport 6767 accept` — but the cleaner path is
  `https://paseo.nomad.opsc.io` with the password, which is also what the phone uses.
* Enabling the relay later is an **outbound** connection (no inbound ports): "The daemon
  connects outbound to our relay server … No open ports required"
  (https://paseo.sh/docs/security.md). It is off unless explicitly enabled.

### 5.4 Blast radius to accept before creating this container

Paseo's plugins are **unsandboxed daemon-side code** and agents run arbitrary commands:

> "Plugins are trusted, unsandboxed code: server code and preparation commands run with the
> daemon user's access on the daemon machine" — https://paseo.sh/docs/plugins.md
> "Agents can still access whatever code and credentials you mount into the container."
> — https://paseo.sh/docs/security.md

So CT 2002 is a *trusted-code* guest: assume anything mounted into `/srv/workspace` can be
read, modified and pushed by an agent, and keep the bind mount scoped to repos that are
safe to lose. Do not put the `dsh-cognee-memory` working tree or anything holding
`/root/technitium.token`-class secrets inside it.

---

## 6. Open questions for the human

1. **Node version is undocumented.** Upstream builds/tests on Node 22
   (`ARG NODE_IMAGE=node:22-bookworm-slim`) but publishes no `engines` field
   (`@getpaseo/cli@0.17.4` metadata has none) and no "requires Node X" statement, while the
   changelog mentions Node 24 fixes. We install 22 as the tested runtime; if `paseo daemon
   run` misbehaves on 22, try 24 before debugging anything else.
2. **`lbzip2` in the image, purpose unstated.** The image installs it; no doc says why
   (likely agent tarball extraction). We install it to match. Harmless either way.
3. **Is the desktop app needed to *manage* the deployment** (plugins, providers)? Docs say
   the CLI covers it (`paseo plugin add`, `paseo daemon …`), and plugins can be installed
   from **Settings → Plugins** in the browser UI too. Worth confirming nothing is
   app-only before we commit to "no Mac required".
4. **Licence/account: settled, but confirm commercially.** No account, no telemetry
   ("Paseo collects no telemetry, requires no account" — https://paseo.sh/docs/security.md),
   Apache-2.0 code. Voice features may pull local models (out of scope).
5. **Hub: SaaS or self-host?** Both exist and Hub is open source
   (`npx @getpaseo/hub`, embedded PGlite or PostgreSQL, `PASEO_HUB_APP_URL` for public
   callbacks — https://paseo.sh/docs/hub/self-hosting.md). It is what turns GitHub/Slack/
   Linear events into agent runs. If we want that, it is a **second** service on this
   cluster (own CT, own DB, public HTTPS for webhooks) — a scope decision, not a Paseo
   requirement.
6. **Router/DHCP on `10.20.10.1` is not inspectable from here.** Nothing in the cluster
   hands out `.23`/`.24` (Technitium DHCP disabled, wrong subnet), but if the gateway runs
   a pool that overlaps `.20–.99`, confirm with whoever owns it. This is the exact class of
   incident recorded in `docs/INFISICAL.md` §10.
7. **Public exposure vs Tailscale-only.** This plan puts the login page on the public
   internet behind TLS + password. If that is unacceptable, the alternative is
   `tailscale serve --bg http://127.0.0.1:6767` (documented) inside the CT and no Traefik
   route at all — same VMID, fewer moving parts, phone must be on the tailnet.
8. **Backups.** Add `2002` to a vzdump job, or accept a nightly `tar` of
   `/srv/paseo/.paseo`? Nothing currently protects it (§3.11).
9. **Where do the fleets' repos live** — `/tank/workspace/paseo` (this plan) or a
   per-project bind mount? Affects whether agents from different "fleets" can see each
   other's trees.

---

## Appendix A — What Paseo exposes for the (out-of-scope) Cognee memory plugin

This is the evidence that the eventual goal is *possible*, not an implementation.

**A plugin is one TypeScript project installed into one daemon**, loaded in-process-adjacent
as a subprocess, with two runtimes:

> "A plugin is a TypeScript project installed into one Paseo daemon."
> "`index.server.ts` — runs in a daemon subprocess" — https://paseo.sh/docs/plugins.md

Installed with `paseo plugin add owner/slug` (reviewed registry `https://plugins.paseo.sh`)
or `paseo plugin install /absolute/path`, gated by a global `pluginsEnabled` switch.

**Hooks are the integration point** — `server.addHook(name, handler)` in `index.server.ts`,
and they run regardless of whether a client is connected ("Hooks run while the plugin is
enabled, even with no app connected", available from 0.14 —
https://paseo.sh/docs/plugins/hooks.md). Full observed set:

| Hook | Payload / what it can change |
| --- | --- |
| `workspace.create.before` / `.after`, `workspace.archive.after` | workspace cwd, isolation choice |
| `worktree.create.before` / `.after` | worktree path, branch |
| `terminal.create.before`, `command.run.before` | shell, env, wrap (only `env`/`wrap` mutable) |
| `agent.create.before` / `.after` | saved config, `env` for the initial launch, metadata |
| **`agent.open.before`** | **`env`, `appendSystemPrompt`, `tools`, `mcpServers`, `wrap` — per session open** |
| `agent.close.after`, `agent.archive.after` | cleanup |
| **`agent.turn.before`** / **`agent.turn.after`** | `{ agent, turnId }` / `{ agent, turnId, outcome }` — live turns only |
| `agent.permission.before` / `.after` | pending permission/question, can answer via SDK |

Mapping to the four requirements:

* **(a) inject context into every turn** — yes, via `appendSystemPrompt` on
  `agent.open.before`: "Instructions follow the saved agent prompt and daemon
  instructions, in plugin order… Reload the plugin after changing its data to apply new
  instructions on the next reopen." (https://paseo.sh/docs/plugins/hooks.md)
* **(b) observe turns and tool calls** — yes: `agent.turn.before/after` for turn
  boundaries, and the turn body is re-read from the timeline with
  `refetch({ direction: "tail", limit: 1, wholeTurns: true })`; tool-level interception is
  `agent.permission.before` (`kind` ∈ `tool|plan|question|mode|other`). Docs example
  literally matches on turn text and sends a follow-up.
* **(c) one memory shared across concurrent agents/workspaces** — yes *within a daemon*:
  the plugin is a single subprocess per daemon and its hooks fire for every agent on that
  daemon, so one in-memory/HTTP client (pointed at Cognee) serves all fleets. **Caveat:** if
  fleets span machines, each daemon runs its own plugin instance — shared memory must live
  in Cognee (`10.20.10.15`), not inside the plugin.
* **(d) per-workspace/per-agent env injection** — yes, exactly the mechanism we need:
  "Session-open overrides are re-derived on every open… `env` … Return `{ …request, env: {
  …request.env, COMPANY_ENV: … } }`" — so `COGNEE_DATASET=<workspace>` or
  `COGNEE_MCP_URL=…` can be injected per session without touching provider config. MCP
  servers can be injected the same way: `agent.open.before` → `mcpServers: { company: {
  type: "http", url: "https://tools.example.com/mcp" } }`.

Two facts to remember when designing it: a `mcpServers` name that collides with a saved
server or Paseo's internal `paseo` server **fails the session open** (so don't call it
`paseo`), and instructions are ignored for `purpose: "history"` opens.

## Appendix B — Docker-in-LXC variant (same VMID, IP, hostname)

Use this only if T1 prefers the upstream artifact over cluster convention. Everything in
§3.7–§3.11 (nftables, Traefik, DNS, backups) is unchanged; §3.3–§3.6 are replaced by:

```bash
# on aimid — note keyctl=1, as CT 106 (cognee) has
pct create 2002 local:vztmpl/debian-13-standard_13.6-1_amd64.tar.zst \
  --hostname paseo --cores 4 --memory 8192 --swap 2048 --rootfs tank-lxc-infra:32 \
  --net0 name=eth0,bridge=vmbr0,ip=10.20.10.23/24,gw=10.20.10.1,type=veth \
  --nameserver 10.20.10.11 --unprivileged 1 --features nesting=1,keyctl=1 --onboot 1 \
  --tags paseo,agents,docker
```

Inside the guest: Docker Engine from docker.com, then

`/opt/paseo/compose.yaml`:

```yaml
services:
  paseo:
    build: .                       # child image: base + agent CLIs
    image: paseo-with-agents
    container_name: paseo
    restart: unless-stopped
    ports: ["10.20.10.23:6767:6767"]
    environment:
      PASEO_PASSWORD: "${PASEO_PASSWORD}"
      PASEO_HOSTNAMES: "paseo.nomad.opsc.io"
      PASEO_TRUSTED_PROXIES: "10.20.10.13"
    volumes:
      - ./paseo-home:/home/paseo
      - /tank/workspace/paseo:/workspace
```

`/opt/paseo/Dockerfile` (verbatim pattern from the docs):

```Dockerfile
FROM ghcr.io/getpaseo/paseo:latest
USER root
RUN npm install -g @openai/codex @anthropic-ai/claude-code opencode-ai
```

— https://paseo.sh/docs/docker.md. Notes carried over from that page: the image listens on
`0.0.0.0:6767` inside the container, state is `/home/paseo/.paseo`, the built-in user is
uid/gid `1000:1000` so the bind mount must be `chown 1000:1000`, and credentials persist
in `/home/paseo` (`docker exec -it --user paseo paseo codex`). `docker compose` then
becomes the systemd unit's `ExecStart` (or use `restart: unless-stopped` alone).

Cost of this variant: nested container + Docker daemon inside the guest, a second
filesystem layer for state, uid-mapping fiddling on the bind mount, and `pct exec` into
CT 106 currently misbehaves (see Appendix C) — which is the operational experience you get
with docker-in-LXC on this cluster.

## Appendix C — Evidence log (read-only commands actually run)

| Claim | Command | Result |
| --- | --- | --- |
| control guests 101–109 | `pct list` (control) | 101…109 as listed in §3.1 |
| aimid guests | `ssh root@10.20.10.20 'pct list; qm list'` | `120 unsloth`, `2001 seaweedfs`; no VMs |
| ids cluster-wide | `cat /etc/pve/.vmlist` | 101–109, 120, 200, 500, 2001 → 2002 free |
| template set | `pveam list local` (aimid) | debian-13-standard_13.6-1, ubuntu-24.04-2 |
| storage | `pvesm status` | `tank-lxc-infra` zfspool, 5,880,264,784 KiB total (≈5.48 TiB), 0.23 % used; `zfs list` on aimid: `tank` 5.46 TiB avail |
| CT 2001 shape | `pct config 2001` | debian, unprivileged, `nesting=1`, 2c/4 GB/16 GB, `.21`, onboot |
| docker-in-lxc flags | `pct config 106` | `features: nesting=1,keyctl=1` |
| native systemd guest | `pct config 109` | `nesting=1`, `.22`, onboot, debian |
| IP liveness (L3) | ping sweep from control **and** aimid | identical 18-host set (§3.1) |
| IP liveness (L2) | `ip neigh flush` + `ping` + `ip neigh show`, both nodes | `.23`/`.24` INCOMPLETE; `.21`/`.22` REACHABLE with MACs matching `pct config` |
| no DHCP interference | Technitium `dhcp/scopes/list` | one scope, `enabled:false`, `192.168.1.0/24` |
| no reverse zone | `dig -x 10.20.10.23 @10.20.10.11` | empty |
| zone convention | Technitium `zones/records/get?listZone=true` | services → `A 10.20.10.13 ttl=300` |
| Traefik version | `pct exec 104 -- /usr/local/bin/traefik version` | 3.7.19 (langres), go1.27.4 |
| entrypoints / provider | `pct exec 104 -- cat /etc/traefik/traefik.yml` | `web`→redirect, `websecure`, `file.directory=/etc/traefik/dynamic watch:true` |
| cert resolver | same file + `acme-wildcard.yml` | `certificatesResolvers.le` (Cloudflare DNS challenge), `sans: ["*.nomad.opsc.io"]` |
| middleware reuse | `cat infisical.yml`, `seaweedfs.yml` | `middlewares: [secure-headers]` referenced without local definition |
| guest firewall pattern | `pct exec 103 -- nft list ruleset`, `cat /etc/nftables.conf` | default-drop; `3080/3081 from 10.20.10.13`; `nftables.service` enabled |
| host firewall off | `pve-firewall status`, `ls /etc/pve/firewall/` | `disabled/running`, empty |
| backup coverage | `cat /etc/pve/jobs.cfg` | `vmid 103,104,105` only |
| workspace storage | `zfs list -d1 tank` (aimid) | `tank/workspace` exists, 5.46 TiB avail |
| Debian node version | `pct exec 2001 -- apt-cache policy nodejs` | candidate `20.19.2+dfsg-1+deb13u3` |
| **limitation** | `pct exec 106 -- echo hi` (repeated, 3×) | **no output, exit 0 / hangs** — could not read `/opt/stacks/cognee` or `docker --version` from the Cognee guest; Compose shape taken from the Paseo docs instead |

Upstream sources cited throughout: `https://paseo.sh/docs.md`, `/docs/docker.md`,
`/docs/web-ui.md`, `/docs/connectivity.md`, `/docs/security.md`, `/docs/configuration.md`,
`/docs/cli.md`, `/docs/workspaces.md`, `/docs/supported-providers.md`, `/docs/plugins.md`,
`/docs/plugins/hooks.md`, `/docs/plugins/reference.md`, `/docs/hub/self-hosting.md`,
`/docs/hub/hosted.md`, `/download`, `github.com/getpaseo/paseo` (README, `releases`,
`docker/base/Dockerfile`, `docker/base/rootfs/usr/local/bin/paseo-docker-entrypoint`,
`LICENSE`), and `registry.npmjs.org/@getpaseo/cli` (0.17.4, Apache-2.0, no `engines`).
