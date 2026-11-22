# Runtime settings for the Cognee address

## What exists, and why this shape

The installed DSH `0.2.1-rc.5` gives a plugin exactly one web extension point:

- `ctx.webServer.register({ kind, path, handler })` — verified at
  `$PKG/dsh-host-webserver/lib/types/index.d.ts:169-174`; `kind` is `'exact' | 'prefix'`,
  `handler` owns the full response lifecycle and receives node's
  `IncomingMessage` / `ServerResponse` (`:34-40`).
- `registerFallback` / `tapIndex` exist too, but the shipped Web composition takes
  the single fallback seat (the SPA), so a plugin must not claim it.

There is **no** host-side settings/config service, so the runtime address has to be a
file this plugin owns. A *client-side* settings section does exist as a slot
(`settings.section`, `$PKG/dsh-client-ui-settings/lib/types/client/contract/slots.d.ts:73`),
but it needs a browser bundle and a live Web shell, and it would not remove the need for
this file; the plugin therefore keeps the host-served page as its settings surface.
See [UI_INTEGRATION.md](UI_INTEGRATION.md) for the client surface and its exact
registration API.

So the plugin ships all three pieces the task allowed:

| Piece | Location | Why |
| --- | --- | --- |
| Persisted settings file | `src/settings/store.ts` | survives restarts, re-read when mtime/size changes (hand edits included) |
| Authenticated HTML page + JSON | `src/settings/http.ts` | the only documented way a plugin can expose UI in this version |
| Active endpoint in `memory_status` | `src/tools/status.ts` via `MemoryCoordinator.activeEndpoint()` | proves what the next call will dial |

## Reaching the page

Both routes are exact-path registrations on the profile's web server:

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/plugins/cognee-memory/settings` | HTML form |
| `POST` | `/plugins/cognee-memory/settings` | validate → persist → `303` back to the form |
| `GET` | `/plugins/cognee-memory/settings.json` | JSON status (no secret) |

On the shipped `web` profile the origin is whatever the web server logs, e.g.
`http://127.0.0.1:3080/plugins/cognee-memory/settings?token=<token>`.

Access requires `COGNEE_MEMORY_SETTINGS_TOKEN` in the harness environment:

- unset → `503` naming the variable; no unauthenticated writes are possible;
- set → `Authorization: Bearer <token>` or `?token=<token>`, compared with
  `timingSafeEqual`. The token is never written into the page markup; the form
  posts to the current URL (`action=""`), so the token stays in the address bar.

Responses carry `cache-control: no-store`, `x-content-type-options: nosniff`, and
`content-security-policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'`
— the page runs no script at all.

## Precedence

Highest first, asserted in `test/settings-store.test.ts`:

1. **stored** — what an operator saved from the page (`$DSH_HOME/plugins/cognee-memory/settings.json`,
   overridable with `COGNEE_MEMORY_SETTINGS_FILE`);
2. **environment** — `COGNEE_MEMORY_API_BASE_URL`, `COGNEE_MEMORY_MCP_URL`,
   `COGNEE_MEMORY_ENABLED`;
3. **profile config** — the plugin's `config:` block in the profile patch;
4. **schema default** — `http://127.0.0.1:8000/api/v1`.

The stored value outranks the environment deliberately: the page exists to change the
target without editing unit files. Clearing the field falls back one level. `mcpUrl`
stores an explicit `null` to record "cleared", which also outranks the environment.

## Hot-reload matrix

| Change | Effective without restart? | How |
| --- | --- | --- |
| Cognee REST base URL | **yes** | `HttpJsonClient` asks `endpoint()` per request; `apply()` passes a closure over the store |
| MCP URL | **partly** | the value is live, but switching REST ⇄ MCP rebuilds a different adapter object, so the transport choice still needs a restart |
| enabled / disabled | **no** | `apply()` returns early when disabled; it is a boot-time decision |
| API key | **no, by design** | read from the environment on each request (`createEnvSecretResolver`), never persisted |

Saving is atomic (`write` + `rename`, mode `0600`) so a crash cannot leave a truncated
file that silently resets the target.

## Validation

`validateCogneeUrl` reuses the exact schema the profile config uses (`httpUrlSchema`)
and adds: absolute http(s), no `user:pass@`, no query, no fragment, ≤ 2048 chars,
trailing slashes normalized. Rejections never echo the submitted value into HTML, and
every interpolated string is escaped (`test/settings-http.test.ts`).

## The key is never exposed

The settings file contains only URL/enable flags. `memory_status` and
`/settings.json` report the credential as `set` / `unset` from the environment
(`COGNEE_API_KEY` by default, `config.apiTokenEnv`) and never its value. Log lines
name the new endpoint only.

## Provenance detail view (0.2.0)

`GET /plugins/cognee-memory/memory/<id>` returns provenance JSON and, with
`?format=html` or `Accept: text/html`, a script-free detail page with a Cognee UI
deep link. `GET /plugins/cognee-memory/memories.json` lists the caller-readable
memories for the side panel. Both use the same `COGNEE_MEMORY_SETTINGS_TOKEN`
(`503` unset, `401` missing/wrong) and the recall scope policy; unknown,
cross-scope, and foreign-principal ids all answer a generic `404`. Every memory
row on the settings page links to its detail page when the request carries a
token. See [UI_INTEGRATION.md](UI_INTEGRATION.md) §"Security model".

## Milestone 9 additions (2026-11-22)

The same two routes now also carry runtime toggles and a read-only inspection
snapshot. Authentication, status codes (`503` unset token, `401` missing/wrong
token, `200` authorized, `415`/`413`/`405`), escaping, `no-store`, CSP, and hot
retargeting of `apiBaseUrl` are unchanged.

### Toggles

`POST` accepts `autoRecall` and `autoWrite` next to `apiBaseUrl` / `mcpUrl` /
`enabled`. They persist in the same JSON file (`stored > env > profile`) and
apply without a restart:

* `autoRecall` — gate for prefetch + prompt injection; explicit `memory_recall`
  still works.
* `autoWrite` — gate for new automatic extraction; already-accepted queue/outbox
  work is still drained, so nothing acknowledged is lost.

Env seeds: `COGNEE_MEMORY_AUTO_RECALL`, `COGNEE_MEMORY_AUTO_WRITE`.

### Inspection (`inspect` hook)

`registerSettingsRoutes` takes an optional `inspect?: () => Promise<SettingsInspection>`.
The plugin wires it to `buildInspection` (`src/settings/inspect.ts`) with the
coordinator, metrics, extraction/outbox, optional adapter inventory
(`GET /datasets` + `GET /datasets/{id}/data`), and a bounded recall ledger.
It runs under a 2.5 s deadline and degrades to a note on the page (still `200`);
the hook is only called after authorization.

The page and JSON add: auto-recall/auto-write toggles, principal + project + readable
scopes, candidate queue counts and outbox operations, ingestion success/failure,
first-turn recall hit rate, recall/prefetch latency p50/p95, context tokens
(last/p95/total), memory count, dataset rows, and read-only per-memory rows with
states `candidate · approved · queued · ingesting · indexed · recall-verified ·
failed · superseded · deleted` (only evidenced states are populated).

No delete/correct action exists on the page: item-level deletion, correction, and
consolidation are deferred. Ingestion/recall counters are process-local; queue,
memory, and state data are read from shared disk and the live backend.
