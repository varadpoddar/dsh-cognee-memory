# SEAWEEDFS — centralized S3 blob storage (CT 2001 on aimid)

SeaweedFS 4.55 in a new LXC on the `aimid` PVE node, backed by 3.5 TiB of the
node's 8 TB SATA SSD, exposed to Cognee (and anything else that speaks S3) as a
single S3 endpoint. Deployed 2026-11-25.

The point of this service is to move Cognee's corpus/blob storage off the
container filesystem and onto a capacity-managed store with one endpoint, so a
future Cognee rebuild does not have to move the data again.

## 1. Topology

| Item | Value |
| --- | --- |
| PVE node | `aimid` (10.20.10.20), PVE 9.2.5, cluster `aimid`/`control`/`ailarge` |
| Container | **CT 2001**, `seaweedfs`, unprivileged |
| OS | Debian 13 (`debian-13-standard_13.6-1_amd64`) |
| Resources | 2 vCPU, 4096 MB RAM, 1024 MB swap, 16 GB rootfs on `tank-lxc-infra` |
| Network | `net0` on `vmbr0`, static 10.20.10.21/24, gw 10.20.10.1, DNS 10.20.10.11 |
| Data | `/data/seaweed` — bind mount of host `/mnt/seaweed` (XFS on `/dev/sda6`) |
| S3 endpoint (in-cluster) | `http://10.20.10.21:8333` |
| S3 endpoint (ingress) | `https://s3-seaweed.nomad.opsc.io` |
| Filer UI | `https://seaweed.nomad.opsc.io` (basic auth) |
| Admin UI | `https://admin-seaweed.nomad.opsc.io` (weed admin login) |
| Credentials | **`/root/seaweedfs-creds`, mode 0600, inside CT 2001** |
| VMID rule | aimid containers are `2xxx`; CT 120 (unsloth) was not touched |

The container is `onboot: 1` with `features: nesting=1` and the PVE default
unprivileged uid mapping (container root = host uid 100000).

## 2. Disk allocation — 3.5 TiB of the 8 TB SSD

`/dev/sda` is a **Samsung SSD 870 QVO 8 TB** (7.3 TiB usable). Before this
deployment it was *not* in LVM, not a `pve` storage, and not thin-provisioned:
it still carried a leftover Windows GPT layout.

```
sda1  200M   vfat  (ESP,  no_automount)
sda2   16M         (MSR)
sda3  977G   ntfs  (Windows C:, unmounted)
sda4  1.9T   ntfs  (Windows data, unmounted)
sda5  200M   vfat  (ESP,  no_automount)
                 ← 4.85 TiB unallocated here
```

Why not LVM: the `pve` VG lives on the 1 TB NVMe boot disk and had ~16 GB free,
so a 3.5 TiB thin volume there was impossible; adding `sda` as a new PV would
have meant destroying the existing NTFS partitions. Why not a ZFS dataset: same
reason — the `tank-*` pools are on the NVMe, and importing `sda` into ZFS would
wipe the partition table.

Least-destructive approach actually used: **one new GPT partition in the
unallocated tail**, nothing else on the disk touched.

```bash
# aimid host, GPT uses GiB units: 3146 GiB → 6730 GiB = exactly 3584 GiB (3.5 TiB)
sgdisk -n 6:3146G:6730G -t 6:8300 -c 6:seaweedfs-data /dev/sda
partprobe /dev/sda
# 3,848,290,697,728 bytes; rmapbt off + 8 AGs keeps metadata overhead ~1 %
mkfs.xfs -f -L seaweedfs -m rmapbt=0 -d agcount=8 /dev/sda6
mkdir -p /mnt/seaweed
echo "UUID=$(blkid -s UUID -o value /dev/sda6) /mnt/seaweed xfs defaults,noatime 0 2" >> /etc/fstab
mount /mnt/seaweed
chown 100000:100000 /mnt/seaweed     # match the unprivileged container's root
pct set 2001 -mp0 /mnt/seaweed,mp=/data/seaweed
```

`fstab` UUID: `d493a767-36ac-4d2e-bca9-3254fb3dfedd`.

Note on units: `df -h` reports TiB, so the 3,584 GiB allocation shows as
`3.5T`. That is the number to check against; the same partition is
3,848,290,697,728 bytes. The disk still has ~0.9 TiB unallocated plus the ~2.7 TiB
of preserved NTFS partitions — the SSD is **not** fully consumed.

Proof inside the container:

```
# pct exec 2001 -- df -h /data/seaweed
/dev/sda6       3.5T   26G  3.5T   1% /data/seaweed
# pct exec 2001 -- lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINTS | grep -A1 sda6
`-sda6        3.5T        /data/seaweed
```

The 26 G "used" is XFS metadata on a 3.5 TiB filesystem, not object data.

## 3. Container creation

```bash
# aimid host
pveam download local debian-13-standard_13.6-1_amd64.tar.zst
pct create 2001 local:vztmpl/debian-13-standard_13.6-1_amd64.tar.zst \
  --hostname seaweedfs --cores 2 --memory 4096 --swap 1024 \
  --rootfs tank-lxc-infra:16 \
  --net0 name=eth0,bridge=vmbr0,gw=10.20.10.1,ip=10.20.10.21/24,type=veth,hwaddr=BC:24:11:2E:AA:01 \
  --nameserver 10.20.10.11 --unprivileged 1 --onboot 1 \
  --features nesting=1 --ostype debian \
  --description "SeaweedFS S3 blob store"
pct set 2001 -mp0 /mnt/seaweed,mp=/data/seaweed
pct start 2001
```

10.20.10.21 was verified unused first (ping sweep of the /24 plus a check that no
A record pointed at it).

## 4. SeaweedFS install (4.55)

```bash
# inside CT 2001
apt-get update && apt-get install -y curl ca-certificates jq
curl -4 -fsSL https://github.com/seaweedfs/seaweedfs/releases/download/4.55/linux_amd64.tar.gz \
  -o /tmp/weed.tgz
tar xzf /tmp/weed.tgz -C /tmp && install -m755 /tmp/weed /usr/local/bin/weed
weed version   # version 30GB 4.55 ... linux amd64
```

`-4` matters: the container has no IPv6 route, and github.com resolves to AAAA
first, so the unqualified `curl` failed with "Could not connect".

One systemd unit per role, all `Restart=always`, `RestartSec=3`, enabled at boot.
Data root `/data/seaweed`.

| Unit | Port | Command (flags that matter) |
| --- | --- | --- |
| `seaweedfs-master` | 9333 | `weed master -ip=10.20.10.21 -ip.bind=0.0.0.0 -port=9333 -mdir=/data/seaweed/master -defaultReplication=000 -metricsPort=9325` |
| `seaweedfs-volume` | 8080 | `weed volume -ip=10.20.10.21 -ip.bind=0.0.0.0 -port=8080 -dir=/data/seaweed/volume -max=0 -mserver=127.0.0.1:9333 -index=leveldb -metricsPort=9328` |
| `seaweedfs-filer` | 8888 | `weed filer -ip=10.20.10.21 -ip.bind=0.0.0.0 -port=8888 -master=127.0.0.1:9333 -defaultReplicaPlacement=000 -defaultStoreDir=/data/seaweed/filer -metricsPort=9326` |
| `seaweedfs-s3` | 8333 | `weed s3 -ip.bind=0.0.0.0 -port=8333 -filer=127.0.0.1:8888 -domainName=s3-seaweed.nomad.opsc.io -metricsPort=9327` |
| `seaweedfs-admin` | 12535 | `weed admin -master=127.0.0.1:9333 -ip=10.20.10.21 -port=12535 -dataDir=/data/seaweed/admin -adminUser=${FILER_ADMIN_USER} -adminPassword=${FILER_ADMIN_PASSWORD}` + `EnvironmentFile=/root/seaweedfs-creds` |

Dependency chain: volume/filer require master, s3 requires filer. Metadata is
leveldb under `/data/seaweed/filer`; chunk data under `/data/seaweed/volume`.

## 5. Credentials

Everything lives in **`/root/seaweedfs-creds` (0600)** inside CT 2001 — the
values are deliberately not in this repo or in any unit file.

```
S3_ENDPOINT_URL=http://10.20.10.21:8333
AWS_ACCESS_KEY_ID=seaweedfsadmin
AWS_SECRET_ACCESS_KEY=<redacted>
AWS_REGION=us-east-1
S3_FORCE_PATH_STYLE=true
FILER_ADMIN_USER=seaweedfs
FILER_ADMIN_PASSWORD=<redacted>
```

The admin unit reads `FILER_ADMIN_*` through `EnvironmentFile=`, so the unit file
itself (world-readable) contains no secret.

### S3 identity — documented CLI method

```bash
# inside CT 2001
set -a; . /root/seaweedfs-creds; set +a
echo "s3.configure -user=seaweedfs -access_key=$AWS_ACCESS_KEY_ID \
  -secret_key=$AWS_SECRET_ACCESS_KEY -actions=Admin -apply" \
  | weed shell -master=127.0.0.1:9333
```

`s3.configure` writes the identity into the filer (`/etc/s3/...`); the running
S3 gateway picks it up without a restart. `weed shell` → `s3.configure` (no
arguments) lists identities to confirm `Status: Active`.

### Filer / admin UI auth

SeaweedFS 4.55 has **no HTTP basic auth on the filer itself** — `weed filer -h`
exposes no auth flag (the filer UI is unauthenticated by design; see the
upstream `Security-Configuration` wiki page, which only offers disabling the UI
or exposing directory metadata). The documented, CLI-configured web UI is
`weed admin`, which is why `seaweedfs-admin.service` runs it with
`-adminUser`/`-adminPassword` from the credentials file.

On top of that, the filer UI on 8888 is protected at the ingress with a Traefik
`basicAuth` middleware using the same `FILER_ADMIN_*` username/password, so
`https://seaweed.nomad.opsc.io` never serves an anonymous page.

## 6. DNS + Traefik

DNS: Technitium CT 102 at 10.20.10.11, primary zone `nomad.opsc.io`. Three A
records were added with the Technitium HTTP API (token lives at
`/root/technitium.token` on `control`):

| Record | Target |
| --- | --- |
| `seaweed.nomad.opsc.io` | 10.20.10.13 |
| `s3-seaweed.nomad.opsc.io` | 10.20.10.13 |
| `admin-seaweed.nomad.opsc.io` | 10.20.10.13 |

10.20.10.13 is Traefik (CT 104 on `control`). The names are intentionally
single-label under the wildcard: the ACME certificate is `*.nomad.opsc.io`, so
`s3.seaweed.nomad.opsc.io` would fall outside it and Traefik would serve its
default self-signed cert. Verified:

```
https://seaweed.nomad.opsc.io        → 401 unauthenticated, 200 with basic auth (filer UI)
https://admin-seaweed.nomad.opsc.io  → 307 to the weed admin login
https://s3-seaweed.nomad.opsc.io/    → 403 XML AccessDenied (not 502)
```

Traefik side: `/etc/traefik/dynamic/seaweedfs.yml` (file provider, same pattern
as `dsh.yml` — `websecure` entryPoint, `tls: {}` to inherit the wildcard,
`secure-headers`, `passHostHeader: true`), services pointing at
`10.20.10.21:8888`, `:12535`, `:8333`. Filer router adds a `seaweed-auth`
basicAuth middleware with
`usersFile: /etc/traefik/seaweed-auth/seaweed.htpasswd`.

Two operational gotchas worth remembering:

* the htpasswd file must live **outside** `/etc/traefik/dynamic`, otherwise the
  file provider tries to parse it as YAML;
* it must be readable by the `traefik` user (mode 640 `root:traefik`), and after
  creating it Traefik needs **one restart** — fixing permissions on an otherwise
  unchanged config does not trigger the file watcher.

## 7. S3 end-to-end verification

`aws-cli 2.42.3` was installed with the static v2 installer
(`awscli-exe-linux-x86_64.zip`) because the Debian `awscli` apt package was
OOM-killed in the 4 GB container. Path-style addressing is required for a
self-hosted endpoint:

```bash
/usr/local/bin/aws configure set default.s3.addressing_style path
```

Smoke test actually run (inside CT 2001, after a container reboot):

```
$ aws --endpoint-url http://10.20.10.21:8333 s3 cp /tmp/probe.txt s3://dsh-corpus/health/probe.txt
$ aws --endpoint-url http://10.20.10.21:8333 s3 ls s3://dsh-corpus/health/
2026-11-25 10:10:36         40 probe.txt
$ aws --endpoint-url http://10.20.10.21:8333 s3 cp s3://dsh-corpus/health/probe.txt /tmp/probe-back.txt
$ cat /tmp/probe-back.txt
seaweedfs s3 smoke 2026-11-25T10:10:29Z
$ aws ... s3api head-object --bucket dsh-corpus --key health/probe.txt --query '[ContentLength,ETag]' --output text
40	"f756d269a4011113b684e6eaa6ab0813"
```

Bucket `dsh-corpus` was created with `aws s3 mb`; the same list+put round trip
works through `https://s3-seaweed.nomad.opsc.io` with a valid wildcard cert.
The smoke script is kept at `/root/s3-smoke.sh` in CT 2001.

### Cognee integration (1.6.10-local)

Cognee writes its file and graph half here; the relational + pgvector half stays
in Postgres on CT 106. Settings live in `/opt/stacks/cognee/.env`
(0600 `root:root`):

| Setting | Value |
| --- | --- |
| `STORAGE_BACKEND` | `s3` |
| `STORAGE_BUCKET_NAME` | `dsh-corpus` |
| `DATA_ROOT_DIRECTORY` | `s3://dsh-corpus/cognee/data` |
| `SYSTEM_ROOT_DIRECTORY` | `s3://dsh-corpus/cognee/system` |
| `CACHE_ROOT_DIRECTORY` | `s3://dsh-corpus/cognee/cache` |
| `AWS_ENDPOINT_URL` | `http://10.20.10.21:8333` (in-cluster) |
| `AWS_ACCESS_KEY_ID` | copied from `/root/seaweedfs-creds` |
| `AWS_SECRET_ACCESS_KEY` | copied from `/root/seaweedfs-creds` |
| `AWS_REGION` | `us-east-1` |
| Addressing | path-style; the endpoint is an IP, so s3fs/botocore select it automatically |
| Bucket | `dsh-corpus` |

`CACHE_BACKEND=postgres` is required because the default SQLite session cache
tries to put `cache.db` under the S3 database path. `GRAPH_DATABASE_SUBPROCESS_ENABLED=false`
is required because the default subprocess mode resolves `s3://...` through
`os.path.abspath()` to `/app/s3:/...` and writes the graph into the container
layer instead of the bucket.

What is actually S3-backed:

* ingested documents: `cognee/data/<user-uuid>/...`;
* Ladybug graph: `cognee/system/databases/<user-uuid>/<dataset-uuid>.lbug`;
* the `cognee/cache/` prefix is reserved (active session cache is Postgres).

What stays local on CT 106: `cognee_db` plus one Postgres database per dataset
under `/opt/stacks/cognee/data/pg`, the UI container, and the empty
`/opt/stacks/cognee/data/cognee` mount.

Cognee 1.6.10-local does **not** read `ENABLE_S3`, `AWS_ENDPOINT_URL_S3`,
`AWS_S3_BUCKET_NAME`, `BUCKET_NAME`, or a Cognee path-style flag. S3 is selected
by `STORAGE_BACKEND=s3` plus `s3://` roots; the only endpoint variable its
`S3Config` reads is `AWS_ENDPOINT_URL`. `S3_FORCE_PATH_STYLE` in
`/root/seaweedfs-creds` is for the AWS CLI, not Cognee.

Verification on 2026-11-25 (empty stack, then a throwaway dataset):
`GET /health/detailed` reported `file_storage.provider=s3`; after `add` the
bucket held `cognee/data/.../text_*.txt`; after `cognify` it held
`cognee/system/databases/.../<dataset>.lbug`; a `CHUNKS` search returned the
document text. Deleting the dataset removed both objects, leaving only the
`health/` smoke objects.

## 8. Capacity and retention

* 3.5 TiB usable, single node, `-defaultReplication=000`, `-max=0`: the volume
  server creates 30 GB volume files on demand and will grow until the
  filesystem is full. Keep ≥10 % free for XFS and the leveldb metadata; alert
  at 85 % `df`.
* No TTL or object-expiry policy is configured. Objects persist until deleted
  through the S3 API or the filer UI.
* Suggested layout: one bucket per project (`dsh-corpus`, future
  `dsh-<project>`), so retention can later become a per-bucket lifecycle
  decision without moving data.
* Metadata (filer leveldb) is as important as the chunks: restoring volumes
  without `/data/seaweed/filer` leaves orphaned blobs.

## 9. Backup and restore

Since 2026-11-25 `dsh-corpus/cognee/` is the authoritative copy of Cognee's
ingested files and Ladybug graphs. The Cognee `pg_dumpall` covers only the
relational/vector half; run both halves from the same quiesced window
(`docs/BACKUP.md`). A SeaweedFS-only backup is not sufficient to restore Cognee,
and a Cognee database dump without this bucket restores metadata pointing at
missing files and graphs.

Backup (quiesced, cheap, node-local):

```bash
# inside CT 2001 — stop writers, stream metadata+chunks to an off-box target
systemctl stop seaweedfs-s3 seaweedfs-filer
tar -C /data/seaweed -czf - filer volume \
  | ssh backup-host 'cat > /srv/backup/seaweedfs-$(date +%F).tgz'
systemctl start seaweedfs-filer seaweedfs-s3
```

For larger stores, snapshot the host filesystem instead of tarring through the
container (`xfs_freeze -f /mnt/seaweed`, LVM/ZFS snapshot of the backing store,
`xfs_freeze -u`), or stream `/data/seaweed/{filer,volume}` to another host. A
second SeaweedFS cluster plus `weed filer.sync` / `filer.backup` is the scale-up
path; there is no second volume host today.

Restore: stop all five units, restore `filer/` **and** `volume/` from the same
backup, start master → volume → filer → s3 → admin, then confirm with
`weed shell` → `volume.list` and an `aws s3 ls` of a known bucket.

## 10. Rollback

**Do not run the teardown below while `dsh-corpus` holds live Cognee data.** It
destroys the only copy of the corpus and graphs. To move Cognee back to local
storage, restore the dump and `.env` per `docs/BACKUP.md`; the commands here are
for decommissioning SeaweedFS only after that data has been migrated or backed
up elsewhere.

```bash
# CT 2001
systemctl disable --now seaweedfs-admin seaweedfs-s3 seaweedfs-filer seaweedfs-volume seaweedfs-master
# aimid host
pct set 2001 -delete mp0
umount /mnt/seaweed
sed -i '/\/mnt\/seaweed/d' /etc/fstab
# Traefik (CT 104)
rm /etc/traefik/dynamic/seaweedfs.yml; rm -r /etc/traefik/seaweed-auth; systemctl restart traefik
# DNS: delete the three A records in Technitium (zone nomad.opsc.io)
# optional, reclaims the 3.5 TiB — the NTFS partitions are unaffected
pct destroy 2001
sgdisk -d 6 /dev/sda && partprobe /dev/sda
```

## 11. Risks / what this deployment does not do

* **Single node, no replication** (`000`): the SSD is the only copy. Backups or
  a second volume host are required before this holds data that cannot be
  regenerated.
* **Consumer QLC SSD** (870 QVO): sustained write throughput drops once the SLC
  cache is exhausted, and the drive has no power-loss protection. Fine for
  corpus blobs and memory artifacts, not for a write-heavy database.
* **Unprivileged container with a host bind mount**: the host path is owned by
  uid 100000; if `/mnt/seaweed` is ever unmounted, the container still starts and
  writes into the host root filesystem. `/etc/fstab` mounts it at boot, but a
  disk failure is silent at the container level — check `findmnt /mnt/seaweed`
  after host maintenance.
* **Filer UI auth is ingress-only**; inside the 10.20.10.0/24 anyone can reach
  `:8888` and `:8333` directly. The S3 port still requires valid credentials;
  the filer UI does not.
* **S3 credentials** now exist in CT 2001 at `/root/seaweedfs-creds` (0600), in
  Cognee's `/opt/stacks/cognee/.env` (0600 `root:root`), and as the bcrypt hash
  on CT 104 for the filer UI. There is no vault entry; rotating the S3 identity
  means updating all three and restarting Cognee. The Cognee API key is
  separate: `/root/cognee-api-key` (0600) on CT 106 and the `COGNEE_API_KEY`
  entries in the two DSH consumer env files on CT 103.
* The Debian `awscli` package does not fit in 4 GB (OOM during install); use the
  static AWS CLI v2 installer if the CLI is reinstalled.
