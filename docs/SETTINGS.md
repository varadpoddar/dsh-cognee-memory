# Runtime settings for the Cognee address

## What exists, and why this shape

The installed DSH `0.2.1-rc.5` gives a plugin exactly one web extension point:

- `ctx.webServer.register({ kind, path, handler })` — verified at
  `$PKG/dsh-host-webserver/lib/types/index.d.ts:169-174`; `kind` is `'exact' | 'prefix'`,
  `handler` owns the full response lifecycle and receives node's
  `IncomingMessage` / `ServerResponse` (`:34-40`).
- `registerFallback` / `tapIndex` exist too, but the shipped Web composition takes
  the single fallback seat (the SPA), so a plugin must not claim it.

There is **no** settings/config service and **no** third-party settings-page slot in
this version: `dsh-client-ui-settings-general` is a bundle-mounted first-party row,
not a slot a package can extend. `grep` for `super(ctx, "settings"`, `"preferences"` or
`"config"` over `$PKG/*/lib/index.js` finds no such service.

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
