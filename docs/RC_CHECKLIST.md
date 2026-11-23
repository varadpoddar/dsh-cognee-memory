# Release candidate checklist — 1.0.1

Status: **candidate, not published.** Every row was executed on 2026-11-23; the
evidence command is given so a reviewer can re-run it.

Artifact: `dsh-cognee-memory-1.0.1.tgz`, 366 KB, 292 files
`sha256 ec19b02dcdd22dc73ba09964f97f62f3c1c6332dd720be54b5bfae7c3d0d4fe5`
(copy kept outside the checkout in `release-candidates/`; `*.tgz` is gitignored).

## 1. Package hygiene

| Gate | Result | Evidence |
|---|---|---|
| `npm pack` from a clean copy succeeds | PASS | `rsync` (no `node_modules`/`.git`/`lib`) → `npm ci` → `npm pack` |
| Tarball contains required files | PASS | `cordis.patch.yml`, `README.md`, `LICENSE`, `CHANGELOG.md`, `lib/index.js`, `docs/ARCHITECTURE.md` present |
| No tests shipped | PASS | `grep -Ei '^test/'` over `tar -tzf` → no match |
| No secrets shipped | PASS | no `.env`, no `.credentials`, no `*.tgz`; the only `secret` paths are the redaction module `lib/security/secrets.*` |
| No `node_modules` | PASS | 292 files, top dirs: `lib` 218, `src` 55, `scripts` 6, `docs` 4 |
| `dsh.bundle` declared | PASS | `{"patch":"./cordis.patch.yml"}` in the packed `package.json` |
| Version stamped | PASS | packed `package.json` → `1.0.1` |

## 2. Build and test

| Gate | Result | Evidence |
|---|---|---|
| Build | PASS | `npm run build` → `tsc -p tsconfig.build.json && node scripts/build-client.mjs`, `built lib/client.js (13402 bytes)` |
| Full suite | PASS | `npm test` → **48 files, 466 tests passed**, 5.09 s |
| Permission regression suite | PASS | `npx vitest run test/permissions.test.ts` → 10/10 |
| Consumer install of the tarball | PASS | fresh `npm init` project + `npm install <tgz>` → `version 1.0.1`, `bundle {"patch":"./cordis.patch.yml"}`, `import('dsh-cognee-memory')` exposes `name`, `inject`, `Config`, `parseConfig`, `MemoryCoordinator` |

## 3. Install as a bundle layer (CT 103, clean `DSH_HOME`)

| Gate | Result | Evidence |
|---|---|---|
| Installs outside the source checkout, as `dsh` | PASS | `DSH_HOME=/tmp/dsh-clean-<ts> dsh plugin --profile rc add /tmp/dsh-cognee-memory-1.0.1.tgz` → `+2 packages, done in 1.1s`, `exit=0` |
| Registers in `dsh.profile.bundles` | PASS | `bundles: [dsh-base, dsh-web-app, dsh-cognee-memory]`; dependency recorded as `file:.../dsh-cognee-memory-1.0.1.tgz` |
| Composes as its own bundle layer | PASS | `dsh --profile rc --dump-config` (1234 entries) ends with `# == dsh-cognee-memory` → `- id: cognee-memory` |
| Tools register / settings 200-401-503 in the clean home | **NOT VERIFIED** | the freshly generated profile does not boot in an empty home: `web-runtime` waits on `webServer` (base/web bundles are not installed by `--from-default-profile` in this build). Route behaviour stays covered by `test/settings-*.test.ts` and by the live instance |

The bundle-layer half is the part this release changes, and it is proven. The
runtime half needs a profile whose base bundles are installed; that is a
harness-bootstrap gap, not a plugin defect, and was left alone rather than
worked around by copying production `node_modules` into the clean home.

## 4. Backup and restore (see `docs/BACKUP.md`, `docs/RESTORE.md`)

| Gate | Result |
|---|---|
| Real backup taken, checksums verified | PASS — `/root/backups/dsh-cognee-20261123T012849Z/`, `sha256: all OK (5 files)` each side |
| Dump integrity | PASS — `gzip -t` OK, 11,473,734 B, **21** `CREATE DATABASE` |
| Isolated restore drill | PASS — 38 s to a serving copy, 21/21 databases, 20 datasets, 54 items, 4 users, 2 API keys, six healthy components, known record + `CHUNKS` hit |
| DSH-side restore | PASS — throwaway `$DSH_HOME`, ledger 104 entries, headless first turn answers `amber-otter-7731`, tool-free assembly recall `FIXTURE_RECALLED=true` |
| Teardown | PASS — isolated containers and scratch dirs removed; backups and evidence kept |

## 5. Open items (do not block the artifact)

1. **`profiles/headless/cordis.patch.yml` is `root:root 0644`** on CT 103. Flagged
   by `scripts/check-permissions.sh`; it is the documented outage class
   (root-owned file under `$DSH_HOME`). Fix is one command, not run here because
   it is production state:
   `chown dsh:dsh /var/lib/deepseek-harness/.dsh/profiles/headless/cordis.patch.yml && chmod 0640 …`
2. **Two superseded backups** (`…T012354Z`, `…T012452Z`) are single-database dumps
   that cannot restore search. Keep or delete with approval; a restore from them
   silently loses the per-dataset databases.
3. **Legacy dirs** `profiles/web.bak-1795371453` (20 MB) and
   `profiles/web/node_modules.100-broken` (9.5 MB) are archived and await a
   deletion decision.
4. Settings-page 200/401/503 in a *clean* home (§3) — needs a bootable profile.

## 6. Rollback

No npm publish, so rollback is `git revert` of the release commit plus removing
the artifact. For an installed host: `dsh plugin --profile <p> remove
dsh-cognee-memory`, restore the profile's `package.json` from
`/root/backups/dsh-cognee-<ts>/dsh/dsh-home.tar.gz`, restart and confirm
`systemctl show -p SubState deepseek-harness.service` = `running`.
