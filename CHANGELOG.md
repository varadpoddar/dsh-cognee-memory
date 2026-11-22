# Changelog

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
