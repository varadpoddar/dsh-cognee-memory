# Changelog

## 1.0.4 — 2026-11-24

Turn journal: conversations become durable tasks with a completed-only-removal
lifecycle. Opt-in (`ingestion.journal.enabled`); no behaviour change when off.

- Every committed turn appends both sides (user text + agent text answers) to
  `ingest-queue.jsonl` as one task per message part, chunked at `chunkChars`
  (nothing truncated). Identity is seeded with `session:turn:seq:role:part`, so
  repeated "continue" turns stay distinct and replays dedupe.
- Lifecycle: `done` tasks are pruned at the end of a drain and their hashes kept
  in `ingest-queue.jsonl.done` for replay idempotency; pending, inflight and
  failed tasks survive restarts and prunes. Unlimited retries (1 h cap);
  permanent refusals are marked `permanent` and stay visible instead of
  retrying nightly.
- Durability: every append is `fdatasync`'d (`ingestion.queue.syncWrites`), and
  enqueue/prune take a cross-process lock so a journaling web process cannot
  race the drainer's rewrite.
- The settings page gains a **Conversation tasks** table (state, role,
  attempts, session/turn, preview) alongside the candidate queue.
- Tests: `test/turn-journal.test.ts` (13) plus hook coverage; suite 544 green.

## 1.0.3 — 2026-11-24

Deployment of the nightly pipeline and the first full-corpus Mac backfill. No
Cognee schema migration; existing datasets, provenance ids and the `dsh`
instance are untouched.

### Redaction defaults

- The LLM PII pass is **off by default** (`COGNEE_PII_ENABLED=false`); one env
  line (`COGNEE_PII_ENABLED=true`) re-enables it. Code comment, CLI help and
  `docs/REDACTION_POLICY.md` now state the default explicitly.
- The deterministic shaped-secret scrub is **unconditional** on the ingest
  path: no env var disables it, and enabling PII does not weaken it. The split
  (credential = incident, name/address = operator choice) is documented, and a
  test asserts shaped secrets are still removed with no options at all.

### Nightly drain correctness

- A standalone `queue drain` no longer exits 0 mid-retry. Retry backoff sleeps
  unref their timer (correct inside the host process, wrong for a CLI), which
  used to empty the event loop and leave items `inflight` with no error. The
  drain now holds one ref'd keep-alive interval for its lifetime.
- `deploy/systemd/dsh-cognify-queue.service` pointed `COGNEE_QUEUE_ENDPOINTS` at
  the LLM endpoint. Queue targets are Cognee writers, so it now names the Cognee
  base URL (twice — two workers against the single endpoint) and sets
  `COGNEE_MEMORY_API_BASE_URL`, the settings env name the CLI actually reads
  (`COGNEE_BASE_URL` is the MCP servers' variable).
- `deploy/` and the pipeline docs are now in the npm `files` list, so the unit
  files ship with the tarball.

### Deployment

- Package installed at `/opt/dsh-cognee-memory` (node 22, runtime deps only),
  owner `varad`, as `su varad`. `dsh-cognify-queue.timer` enabled and verified;
  `dsh` and `deepseek-harness-varad.service` still `active`/`running`.

### Full Mac-history backfill

- 682 Mac sessions → **247 unique queue items**; drained at 2 workers against the
  single Cognee endpoint in **51 m 46 s** (12.6 s/item wall, 123/122 split).
- **245 done** first attempt, 2 terminal failures (payloads starting with
  `http(s)://` get a `403` from Cognee, which treats them as external URLs); both
  re-enqueued with a `url: ` prefix and ingested, so 247/249 items landed.
- Dataset `dsh-project-varad-mac-history-5c5a11e6b8d6859e32a4`
  (`c74cc337-4d0c-5ac9-b85f-8d6560be37a1`), **254 records** (9 pre-existing + 245
  new; 2 items deduplicated at write time).
- Verified: 5/5 sampled records re-retrieved by `CHUNKS`; 5/5 facts quoted
  verbatim by the varad instance's `memory_recall`; a fresh tools-off single
  message recalled an older Mac conversation's Task 1 branch/constraint.

### Operations (2026-11-24, later same day)

- `dsh.nomad.opsc.io` now serves the **varad** instance: varad's unit takes the
  public origin (`--public-url https://dsh.nomad.opsc.io/`,
  `--trusted-host dsh.nomad.opsc.io`), nftables admits 3081 from Traefik only,
  and the Traefik route points at `10.20.10.12:3081`. Verified by token
  ownership (varad token 200, dsh token 401). The `dsh` instance is unchanged
  and still reachable on `10.20.10.12:3080`.
- Nightly drain moved from 02:30 to **04:00 America/Los_Angeles**
  (`Persistent=true`, `RandomizedDelaySec=300`; next run 04:02 PST).
- Documented the disk-first spools (`candidates.jsonl`, `outbox.jsonl`,
  `ingest-queue.jsonl`), their caps (100 candidates; 6 queue attempts) and who
  drains each, in `docs/INGEST_PIPELINE.md`; switch + rollback in `docs/RUNBOOK.md` §10.

## 1.0.2 — 2026-11-23

Profile-layer, service and panel hardening. No Cognee schema migration; memory
data and existing provenance ids are preserved.

### `ctx.cognee` is a real Cordis Service

- `@deepseek-ai/cordis@4.0.5` (the exact version DSH 0.2.1-rc.5 bundles) is now
  a required peer dependency, and the deployed web profile lists it directly.
  `pnpm why @deepseek-ai/cordis` resolves one install.
- `ctx.cognee` is a `class CogneeService extends Service`, not an object passed
  to `ctx.provide`. Registration is fiber-owned: dispose unregisters it and a
  reload leaves exactly one registration. The method surface is unchanged
  (`recall` / `remember` / `forget` / `status` / `scopesFor`).
- The API is built before `super()` so a dependent activated synchronously by
  Cordis can call the service immediately.

### Panel and model-visible links

- Every `Known context:` line now ends with the memory's absolute provenance URL
  (`settings.publicBaseUrl` + `/plugins/cognee-memory/memory/<id>`). The URL
  never contains the settings token; the memory text remains first on the line.
- The retrieval cap is unchanged (stable 300 + query 900 tokens). The budget
  planner counts the URL and drops whole lower-ranked items if needed.
- `GET /plugins/cognee-memory/memory/<id>?format=page` returns the CSP-safe
  provenance panel (dataset, document/data id, `created_at`, confidence, source
  refs, excerpt, Cognee UI deep link). `format=html` remains an alias; no
  `format` returns JSON. Authorized `200`, missing token `401`, foreign id
  `404`.

### Packaging

- Version 1.0.2 tarball; `cordis.patch.yml`, `dsh.bundle`, built `lib/`, docs
  and scripts ship, tests and credentials do not.
- Deployment runbook now records the base-profile reset and the Traefik panel
  checks.


## 1.0.1 — 2026-11-23

Backup, restore and packaging hardening. No change to the plugin's runtime
behaviour, tool surface, settings page or wire contract — this release adds the
operational tooling around the plugin and the tests that pin its on-disk
invariants. Existing installs need no migration.

### Backup and restore

- **`scripts/backup.sh` / `scripts/backup-all.sh`** — application-consistent
  backup of both halves of the memory stack. Writes are quiesced with
  `docker pause` (auto-unpaused from an `EXIT` trap, so a failed dump never
  leaves the API down) and the relational dump plus the embedded ladybug graph
  are taken from the same instant. Each side writes
  `/root/backups/dsh-cognee-<ts>/` with `SHA256SUMS` and a versioned
  `MANIFEST.json` (commit sha, plugin and Cognee versions, exact SQL counts and
  per-table row counts).
- **`pg_dumpall`, not `pg_dump`.** Cognee keeps one postgres database per
  dataset for the search path. Dumping only `cognee_db` restores every dataset
  row and the whole graph, but every `CHUNKS` search then fails with
  `database "<dataset-uuid>" does not exist`. A restore drill caught this;
  `docs/BACKUP.md` explains it.
- **`scripts/restore-drill.sh`** — restores a backup into an isolated stack
  (own compose project, own data dir, port 18001) and asserts it: 21/21
  databases, 20 datasets, 54 items, 4 users, 2 API keys, all six health
  components, and one known record retrieved through `CHUNKS`.
  Empty machine to serving copy: **38 s**.
- **`scripts/verify-backup.sh`** — checksums, gzip integrity, dump contents and
  manifest sanity for one side of one backup.
- **`docs/BACKUP.md`**, **`docs/RESTORE.md`** — what is backed up and why, the
  consistency order, the exact restore and rollback commands, measured timings,
  and the gotchas (per-dataset databases; a cluster restore needs a superuser;
  the graph lives in storage plus its WAL, not in postgres).

### Permissions

- **`scripts/check-permissions.sh`** — asserts `/etc/dsh/*.env` is
  `0640 root:dsh`, that `$DSH_HOME` and its profiles/sessions/ledger are owned
  by `dsh`, and that no root-owned file exists under `$DSH_HOME`. Run against
  the live host, it immediately found `profiles/headless/cordis.patch.yml`
  owned by `root:root` at `0644`.
- **`test/permissions.test.ts`** (+ `test/helpers/permissions.ts`) — the same
  invariants as root-free unit tests over injected `stat` data, including a
  root-owned profile manifest failing loudly with the path, the diagnosis and
  the fix in the message.

### Documentation

- Internal hosts removed from `README.md` (`10.20.10.15` → `cognee.internal`,
  `10.20.10.30` → `llm-host`). No key, token, password or JWT material appears
  in any shipped document.


## 1.0.0 — 2026-11-22

First stable release. No DSH core patch; the plugin still mounts through one
profile row and uses only `ctx.tools.register`, `ctx.systemPrompt.*`, agent and
session events, and `ctx.webServer.register`.


### Packaging

- **The package now declares `dsh.bundle`** (`{"patch": "./cordis.patch.yml"}`),
  matching the shape of the shipped experimental bundles
  (`@deepseek-ai/dsh-experimental-ralph-bundle`). `cordis.patch.yml` inserts the
  `cognee-memory` row, so `dsh plugin add` registers the package in
  `dsh.profile.bundles` as a real profile layer instead of installing it as a
  plain dependency. Deployment-local config (API base URL, scope, limits) stays
  in the profile's own `cordis.patch.yml` as an id-targeted `config` override;
  an `insert` block for the same id would mount the plugin twice. An existing
  plain-dependency install is not re-registered: remove and re-add the package
  once (`dsh plugin --profile web remove dsh-cognee-memory` then `add <tgz>`).


### Added

- **M13 `memory import-history` backfill.** A new `memory` CLI (bin
  `./lib/cli/main.js`) scans `$DSH_HOME/sessions/**/session.v*.jsonl.zstd`,
  decodes the concatenated Zstandard frames (a Node one-shot decompressor stops
  at the first frame), and reuses the M3 extraction policy: committed direct
  `user/message` text only, text blocks only, deterministic explicit commands
  (`remember …`, `forget …`, `actually …`) only — never whole transcripts,
  never hidden reasoning. Secrets are blocked before a write; the dry run
  (default) reports counts, date range, candidate types, target namespaces, and
  redaction/skip counts without writing. Apply is idempotent and resumable: the
  state file records the extraction idempotency key plus the source ref
  (session id + message index), and candidates are applied in timestamp order so
  a later correction supersedes the earlier fact.
- **Durable record ledger.** `src/memory/ledger.ts` mirrors every accepted
  durable write (text, semantic key, provenance, confidence, timestamps, source
  refs) because Cognee exposes raw text only through `/search`. Append-only,
  0600, bounded text, redacted, never a credential; a ledger failure never
  fails a memory write.


### Added

- **M14 portable export/import bundles.** `memory export --scope <ns>
  --out bundle.jsonl` writes one `bundle` header plus one `record` line per
  active durable memory with text, canonical semantic key, coarse confidence,
  timestamps, provenance, and bounded source refs (session id + message index).
  Records containing a credential are refused, so a bundle never carries a
  secret. `memory import --in bundle.jsonl --scope <ns> [--allow-scope …]
  [--apply]` is a dry run by default: it dedupes on the semantic key inside the
  target scope (re-import adds 0 records), records a different fact under an
  existing key as an append-only conflict annotation instead of overwriting the
  memory, and authorizes the target against the deployment's writable scopes
  plus explicit operator grants — a bundle's own scope claims are provenance
  only, they can never widen where records land.


### Fixed

- **Prefetch ranking: the stable layer could consume the whole item budget.**
  Milestone 11 scenario D missed a maintenance fact in a tools-disabled
  prefetch: the stable 300-token layer filled all 8 item slots, so the query
  layer received `max(0, 8 - stable)` = 0 slots. The coordinator now reserves
  `ceil(maxItems / 2)` slots for the query layer, flows unused reservation back
  to stable, and backfills leftover slots from stable candidates. Per-layer
  token caps (300 / 900), the combined 1200-token cap, the 8-item cap and the
  1500 ms deadline are unchanged. Regression:
  `test/retrieval.test.ts` “reserves item capacity…” (fails on the old code).
- **Cognee CHUNKS scores were ranked backwards.** `/search` with `CHUNKS`
  returns ascending vector *distance* in `score` (exact match 0.0486, unrelated
  0.39–0.49) while `RecallService` sorts descending, so the least relevant
  memory was ranked first. The REST adapter now converts CHUNKS distance to
  similarity (`1 - distance`) at the boundary; other search types are
  unchanged. Regression: `test/cognee-rest.test.ts` “converts CHUNKS distance
  scores…”.

### Added

- Release metadata: `1.0.0`, complete `files`/`exports`, `engines.node >=22`,
  DSH peer dependencies, repository/homepage/bugs, MIT license, keywords,
  `sideEffects: false`.
- [`README.md`](README.md) rewritten as an operator-facing release README
  (install, configure, upgrade, rollback, uninstall, security, architecture,
  troubleshooting).
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — exact CT 103 commands, service
  account, env files, restart requirement, verification, smoke procedure.
- [`ROLLBACK.md`](ROLLBACK.md) — stop → remove → restore profile → restart.
- [`docs/PR.md`](docs/PR.md) — prepared pull-request description (not pushed).
- Fresh-install smoke test: `npm pack` → install the tarball into a clean
  throwaway `DSH_HOME` on CT 103 → confirm the plugin mounts, tools register,
  the settings page answers, and a tools-off first turn recalls a fixture.

### Milestones

| # | Milestone | Outcome |
| --- | --- | --- |
| 1 | First-turn retrieval | Bounded `Known context:` block from the real first message |
| 2 | Stable identity and scopes | session / agent / project / team / global datasets, deny-by-default policy |
| 3 | Automatic extraction | Explicit user facts become durable memory without a tool call |
| 4 | Durable write path | Candidate queue + outbox survive process exit; exact/near dedup |
| 5 | Resilience and metrics | Timeouts, `failureMode: open` degradation, bounded counters |
| 6 | Two-layer retrieval coordinator | Stable + query layer, shared deadline, strict token/item caps |
| 7 | Tool surface | remember/recall/forget/status, lossless JSON output, write policy |
| 8 | Security hardening | Credential redaction, injection-neutralized prompt block, scope isolation |
| 9 | Settings page | Authenticated runtime Cognee address, precedence and hot reload |
| 10 | Provenance | Per-memory provenance index, JSON/HTML routes, sidebar panel |
| 11 | Evaluation | Live narrow-slice scenarios A–F, K, N, O with measured numbers |
| 12 | Release 1.0.0 | Ranking fix, packaging, docs, fresh-install smoke, PR description |

### Verification

- `npm ci && npm run build && npm test` from a clean checkout of the packed
  tarball: **45 test files, 454 tests passed**.
- CT 103 smoke (clean `DSH_HOME=/var/lib/deepseek-harness/.dsh-smoke`, removed
  after): tarball installed, `--dump-config` composed the `cognee-memory` row
  from the tarball, `memory_status` executed against the live Cognee
  (`reachable: true`), the settings page answered `200` with the operator token
  and `401` with a wrong token, and a tools-disabled first response returned
  `m12-rank-window-0300-0400` with no tool calls.

## 0.2.1 — 2026-11-22

### Fixed

- **`memory_recall` rejected by the host with `value is not lossless JSON`.**
  `ScopeRef` carries `legacyName` as a *non-enumerable* own property; `RecallHit`
  scopes were copied straight into the tool value, and DSH's output validator
  rejects any object with a non-enumerable own key (JSON would silently drop it).
  `memory_remember` and `memory_forget` had the same latent defect but were not
  exercised. All three tools now project scopes through `scopeValue()`
  (`src/tools/shared.ts`), so the boundary always sees `{scope, id}`.
  Regression: `test/tools-lossless-output.test.ts` (5 tests, mirrors the DSH walker).

## 0.2.0 — 2026-11-22

UI surface, provenance, and publish readiness. No DSH core patch; the plugin
still uses only `ctx.tools.register`, `ctx.systemPrompt.section`, agent/session
events, and `ctx.webServer.register`.

### Added

- **Memory-provenance side panel** (browser half). The package declares
  `dsh.client` and ships `lib/client.js`, a lazy
  `window.__ModuleLoader__.load({ id, factory })` module that registers a
  right-Sidebar tab type in the `extension` priority band
  (`ctx.sidebarRightTabs.register`) and its body in `sidebar.right.pane.tab`.
  The panel lists recalled memories as `label · scope · date` with a link to
  each provenance page, looks a memory id up as JSON, and holds the operator
  token in component state only.
- **Provenance index and routes.** `GET /plugins/cognee-memory/memory/<id>`
  returns provenance JSON (dataset name + UUID, document/data id, created_at,
  ingest state, search type that surfaced it, coarse confidence, semantic key,
  supersedes/superseded-by, source refs, bounded excerpt) and a script-free HTML
  detail page (`?format=html` or `Accept: text/html`) with a Cognee UI deep
  link. `GET /plugins/cognee-memory/memories.json` serves the bounded list the
  panel reads. Authorization is the settings token and the recall scope policy;
  unauthorized, cross-scope, and foreign-principal ids answer a generic 404.
- **Polished settings page**: responsive cards, dark/light CSS variables,
  status chips, focus-visible outlines, and a per-memory "Open" provenance link.
- **Packaging**: publish metadata (`license`, `keywords`, `engines.dsh`,
  `exports`, peer dependencies, `files`), `LICENSE`, this changelog, a
  deterministic client-bundle build with `--check`, and `prepack` verification.

### Changed

- **Model-visible injection format** is now `Known context:` followed by one
  `label · scope · date` line per memory (was
  `Known context (recalled memory; may be incomplete):` plus
  `- [scope · confidence] text`). Confidence stays in the provenance view; the
  security property ("memory is data, never instructions") remains system text.
  Token budgets and item caps are unchanged.
- `docs/SETTINGS.md` and `src/settings/store.ts` no longer claim that
  0.2.1-rc.5 has no UI extension points: the client-side slot system exists and
  is documented in `docs/UI_INTEGRATION.md`. The host-served settings page
  remains the surface that works without a browser bundle.

## 0.1.0 — 2026-11-21

Initial live-verified release: Cognee REST/MCP transport, deny-by-default scope
policy, remember/recall/forget/status tools, prefetch + prompt injection,
automatic extraction with candidate queue and durable outbox, task-outcome
write-back, metrics, and the authenticated settings page.
