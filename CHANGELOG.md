# Changelog

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
