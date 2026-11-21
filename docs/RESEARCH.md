# RESEARCH — DSH plugin contract for a Cognee persistent-memory plugin

**Phase 0 research only.** No plugin implementation code exists in this repo yet, no
Cognee server was contacted, and nothing under the DSH installation was modified.

**Method.** Every claim below was read out of the *installed* `0.2.1-rc.5` package tree
(compiled `lib/*.js` plus `lib/types/*.d.ts`), out of the live user profile under
`~/.dsh/profiles/`, or out of an upstream doc fetched over HTTP. Anything I could not
prove is marked **UNVERIFIED** or **NOT FOUND** with the search that failed. I did not
infer API names from general Cordis/Koishi knowledge.

**Path shorthand** used in citations:

| Symbol | Absolute path |
| --- | --- |
| `$DSH` | `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh` |
| `$PKG` | `$DSH/node_modules/@deepseek-ai` (nested real packages, 306 of them) |

---

## 1. Version, commit, runtime

| Fact | Value | Source |
| --- | --- | --- |
| DSH version | `0.2.1-rc.5` | `$DSH/package.json:4` |
| Git commit of installed tree | `c3286d37c37f71b186a7e6647092bf2b56d1d690` | `git rev-parse HEAD` in `$DSH` |
| `name` / `bin` | `@deepseek-ai/dsh`, bin `dsh` → `lib/bin.js` | `$DSH/package.json:2,24-26` |
| Module type | `"type": "module"` (ESM only) | `$DSH/package.json:22` |
| Node | `v25.4.0` | `node -v` |
| npm | `11.7.0` | `npm -v` |
| pnpm | `12.16.1` | `pnpm -v` |
| Cordis | `@deepseek-ai/cordis` `~4.0.5` | `$DSH/package.json` dependencies |
| Schemastery | `@deepseek-ai/schemastery` `~3.18.5` | `$DSH/package.json` dependencies |

The installed package ships **only** `lib/`, `LICENSE`, `README*.md`, `package.json` and
`node_modules/` — there is no `docs/` directory, which is why upstream docs had to be
fetched over HTTP (§11). The CLI itself is a thin launcher: `$DSH/lib/` contains only
`bin.js`, `plugin-*.js`, `profile-boot*.js`, `dump-config*.js` and `types/`. All real
plugin machinery lives in the 306 nested `@deepseek-ai/*` packages under `$PKG`.

---

## 2. Active profiles and installed plugins

`DSH_HOME` is set to `/Users/varad/.dsh` (`$PKG/dsh-home-paths/lib/types/index.d.ts`
defines `DSH_HOME_ENV = "DSH_HOME"` and default dir `.dsh`). Two profiles exist:

| Profile | Path | Bundles (`package.json` → `dsh.profile.bundles`) |
| --- | --- | --- |
| `web` | `~/.dsh/profiles/web/` | `dsh-base`, `dsh-web-app`, `dsh-experimental-agent-team-profile`, `dsh-subagent-codex`, `dsh-codex-connect`, `@local/dsh-codex-ollama-orchestrator`, `dsh-hierarchical-orchestrator`, `dsh-hierarchical-orchestrator-ui` |
| `desktop` | `~/.dsh/profiles/desktop/` | `dsh-base`, `dsh-web-app`, `dsh-experimental-agent-team-profile` |

Source: `~/.dsh/profiles/web/package.json` (`dsh.profile.bundles`), same file in `desktop`.

**Active profile = `web`.** Verified live: `ps` shows `node /opt/homebrew/bin/dsh web`
(PID 56806) and `lsof -nP -iTCP:3080` shows that PID listening on `127.0.0.1:3080`.
The `desktop` profile is present on disk but not running.

The composed `web` tree was captured with `dsh --profile web --dump-config`
(saved verbatim at [`docs/research/dump-config-web.yml`](research/dump-config-web.yml)):
**204 tree entries, 29 of them `disabled: true`**, composed from 8 bundle layers plus
the user patch layer. Representative tool rows:

```yaml
- id: tool-todo
  name: '@deepseek-ai/dsh-tool-todo'
- id: tools
  name: '@deepseek-ai/dsh-tools'
  config:
    mode: !!js process.env.DSH_TOOLS_MODE
```

**MCP status in the active profile:** the composed tree contains
`- id: mcp-resources, name: '@deepseek-ai/dsh-mcp-resources'` but contains **no
`dsh-mcp-client` entry at all** (`grep -n mcp` over the dump returns only `mcp-resources`).
So the MCP client plugin is installed as a package but is **not mounted** in the `web`
profile today. If Cognee exposes MCP, that is a config-only (`insert:`) addition — §10.

**Prompt-relevant rows already mounted** (useful as reference implementations):
`system-prompt` (with `personaPrefix`), `persona`, `agent-instructions`
(`maxBytes: 65536`, `disabled: true` at global scope but enabled inside agent presets),
`time-context`, plus `tools` and `session`.

---

## 3. Plugin registration contract (verified)

### 3.1 What a plugin package's `package.json` must contain

A loadable plugin is an ESM package whose entry point exports the Cordis plugin
symbols. Verified against a real shipped plugin, `$PKG/dsh-tool-todo/package.json` and
`$PKG/dsh-mcp-client/package.json`:

```jsonc
{
  "name": "@deepseek-ai/dsh-tool-todo",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".":            { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./src/*":      "./src/*",
    "./package.json": "./package.json"
  },
  "peerDependencies": { "@deepseek-ai/cordis": "~4.0.5" }
}
```

Findings:

- **No** `cordis` / `koishi` manifest field and **no** special `keywords` entry are
  required — I checked `package.json` of `dsh-tool-todo`, `dsh-mcp-client`,
  `dsh-time-context`, `dsh-persona`, `dsh-system-prompt`, `dsh-base`; none carries one.
  (`grep` for `"cordis":` / `"koishi":` in those manifests returns nothing.)
- `main` + `exports["."]` pointing at the ESM entry is what the loader resolves.
- Subpath exports are themselves mountable: the dump contains
  `name: '@deepseek-ai/dsh-plugin-manager/tools'` and
  `name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'`.
- `@deepseek-ai/cordis` belongs in `peerDependencies`, **not** `dependencies`, so the
  plugin shares the host's Cordis instance.
- A *bundle* package (a distribution layer, not a plugin) instead declares:
  `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` — verified in
  `$PKG/dsh-base/package.json` and in the working local package
  `~/Documents/deepseek-harness/default-workspace/hierarchy-test-monitor/package.json`.

### 3.2 What the plugin module must export

Verified end-to-end on `$PKG/dsh-tool-todo/lib/types/index.d.ts:15-30` and
`$PKG/dsh-mcp-client/lib/types/index.d.ts:89`:

```ts
export declare const name = "tool-todo";        // plugin name (string literal)
export declare const inject: string[];           // required services, e.g. ['tools','sessionProjections']
export declare const Config: z<Config>;          // Schemastery schema for the config block
export declare function apply(ctx: Context, config: Config): void;  // or Promise<void>
```

- `apply(ctx, config)` is the entry point; `mcp-client` types it
  `apply(ctx: Context, config: Config): Promise<void>` (async allowed).
- `Config` is a Schemastery (`z` from `@deepseek-ai/schemastery`) schema and is
  **optional** for config-less plugins (the local `hierarchy-live-test/monitor.js`
  exports only `inject` + `apply`).
- Named exports are deliberate: the comment at
  `$PKG/dsh-tool-todo/lib/types/index.d.ts:5` says *"Named exports preserve loader
  injection metadata."*
- Lifecycle teardown is **not** an exported function. Anything registered on a service
  returns a disposer, and Cordis disposes it with the owning fiber (§6).

### 3.3 Class-style plugins and services

A class plugin extends `Service` and calls `super(ctx, name)`:
`$PKG/cordis/lib/types/service.d.ts:10-40` — *"Subclasses call `super(ctx, name)` from
their constructor. The service is registered immediately and is automatically removed
with the owning fiber."* `[Service.init]` is the post-construction method symbol and is
where async startup belongs (e.g. `WebServer.[Service.init]()` listens,
`$PKG/dsh-host-webserver/lib/types/index.d.ts:200`).

---

## 4. Tool registration API (verified)

**Exact API:** `ctx.tools.register(defineTool({ ... }))`.

- Service: `class ToolRuntime extends Service` — `$PKG/dsh-tools/lib/types/index.d.ts:527`;
  registered under the name `"tools"` (`super(ctx, "tools")` at
  `$PKG/dsh-tools/lib/index.js:2798`).
- Method: `register(definition: ToolDefinition): () => void` —
  `$PKG/dsh-tools/lib/types/index.d.ts:637`. **Returns a disposer.**
- Helper: `defineTool<const S, const O>(options: DefineToolOptions<S, O>): ToolDefinition`
  — `$PKG/dsh-tools/lib/types/schema.d.ts:248`.
- Real call site: `ctx.tools.register(defineTool({ ... }))` at
  `$PKG/dsh-tool-todo/lib/index.js:95`.

`DefineToolOptions` (`$PKG/dsh-tools/lib/types/schema.d.ts:178-230`):

| Field | Requirement |
| --- | --- |
| `name` | string, unique |
| `description` | string, sent to the model |
| `parameters` | `ParameterSchemaSpec` — per-property schema, "compiled to an implicit open object root" |
| `output.schema` | **mandatory** canonical output JSON Schema |
| `output.render(args, value)` | **mandatory** pure projection to `ContentBlock[]` |
| `output.presentationMeta?` | optional pure presentation metadata |
| `execute(args, exec): Promise<InferValue<O>>` | **mandatory**; must observe/forward `exec.signal` |
| `timeoutMs?`, `isConcurrencySafe?`, `deferLoading?`, `projectContent?`, `finalizeContent?` | optional |

Two things worth flagging for the design phase:

1. **A mandatory `output` contract.** `ToolDefinition` extends `ToolSchema` and declares
   `readonly output: ToolOutputDefinition` (`$PKG/dsh-tools/lib/types/index.d.ts:115-121`).
   A tool cannot return free-form text; it returns a canonical JSON value that must
   validate against `output.schema`, and `output.render` produces the model-facing
   blocks. So a `recall` tool's return shape must be designed up front.
2. **The schema is not raw JSON Schema and not zod.** Parameters use
   `ParameterSchemaSpec`; `zod` appears in `dsh-time-context` for MCP-side validation
   only, and `dsh-tools` exposes converters `jsonSchemaToTs`, `jsonSchemaToPy`,
   `renderToolsSdk` for SDK surfaces.

`dsh-tools` also emits a `'tools/change'(): void` event (`@mode emit`,
`$PKG/dsh-tools/lib/types/index.d.ts:~100`) so UIs can react to tool-set changes.

---

## 5. System-prompt and dynamic-context contribution API (verified)

**Exact API:** `ctx.systemPrompt.section(...)` and `ctx.systemPrompt.context(...)`.

- Service: `class SystemPrompt extends Service` — `$PKG/dsh-system-prompt/lib/types/index.d.ts:237`;
  registered as `"systemPrompt"` (`super(ctx, "systemPrompt")` at
  `$PKG/dsh-system-prompt/lib/index.js:226`).
- `section(section: PromptSection): () => void` — `index.d.ts:250`; *"Register an ordered
  prompt section in the calling context's scope. A scoped section shadows a global
  section with the same name; duplicates within one scope throw."* Disposer labelled
  `"systemPrompt.section()"` at `lib/index.js:255`.
- `context(context: PromptContext): () => void` — `index.d.ts:264`; **dynamic model
  context materialized as a durable user-role snapshot** (`index.d.ts:71`). Disposer
  labelled `"systemPrompt.context()"` at `lib/index.js:281`.
- Also available: `tools(provider)` (`systemPrompt.tools()`, `lib/index.js:300`),
  `variable(name, provider)` (`lib/index.js:312`), and
  `suppressRuntimeContext()` (`lib/index.js:290`).
- A section/context `text` may be a string **or** `(context: AssembleContext) => string`
  (`index.d.ts:60,78`), so text can be computed per assembly.
- Extension point: waterfall `'system-prompt/assemble'` —
  `$PKG/dsh-system-prompt/lib/types/index.d.ts:27` (see §6). This is the hook for
  *post-hoc* rewriting of the whole assembly rather than adding a section.
- Reserved section names exist and must not be collided with:
  `PERSONA_PREFIX_SECTION = "deployment:persona-prefix"`,
  `PERSONA_SUFFIX_SECTION = "deployment:persona-suffix"` (`index.d.ts:172-174`), plus
  centrally allocated placement names via `getSectionOrder(name)` / `getContextOrder(name)`.

`$PKG/dsh-persona` is the smallest real example of a section contributor: it exports
`name = "persona"`, an `inject` array, a `Config: z<Config>` and applies
`PERSONA_PREFIX_SECTION` for its scope — see `$PKG/dsh-persona/lib/types/index.d.ts:1-45`.

---

## 6. Lifecycle hooks that actually exist in 0.2.1-rc.5

All of the following are declared in merge-extensible event interfaces, so
`ctx.on('<name>', handler)` type-checks. Modes are quoted from the declarations.

**Agent hooks** — `$PKG/dsh-agent/lib/types/runtime-types.d.ts`:

| Event | Line | Mode / payload |
| --- | --- | --- |
| `agent/created` | 227 | `{ agent }` |
| `agent/disposed` | 240 | `{ agent }` |
| `agent/status` | 252 | agent status change |
| `agent/inbox/inserted` | 263 | inbox insert |
| `agent/inbox/claimed` | 277 | inbox claim |
| `agent/inbox/discarded` | 289 | inbox discard |
| **`agent/pre-step`** | **304** | **`@mode waterfall`**, `(payload: {agent, messages, turn, step, signal}, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>` |
| `agent/request` | 327 | `@mode waterfall`; *"runs after assembly and `step/start`, before the system prompt and accepted user batch are committed"* |
| `agent/request-error` | 348 | — |
| `agent/assistant-stream` | 366 | — |
| `agent/turn-stopping` | 387 | — |
| `agent/error` | 402 | — |

**Session hooks** — `$PKG/dsh-session/lib/types/index.d.ts`:

| Event | Line | Signature |
| --- | --- | --- |
| `session/created` | 41 | `(session) => void` |
| `session/disposed` | 50 | `(session) => void` |
| `session/event` | 61 | `(session, event: SessionEvent) => void` |
| `session/flush` | 69 | `(session) => Promise<void> \| void` |

**Prompt hook** — `system-prompt/assemble` (`@mode waterfall`) at
`$PKG/dsh-system-prompt/lib/types/index.d.ts:27`.

**Tools hook** — `tools/change` (`@mode emit`) at `$PKG/dsh-tools/lib/types/index.d.ts:~100`.

**Cordis core** — the only event-family entries are `internal/*`
(`internal/plugin`, `internal/status`, `internal/config`, `internal/service`,
`internal/update`, `internal/get`, `internal/set`, `internal/listener`,
`internal/dispatch`) at `$PKG/cordis/lib/types/events.d.ts:218-238`. **There is no
public `ready` event and no public `dispose` event**; startup/teardown are the
`Service` symbols `[Service.init]` / `[Service.check]` (`$PKG/cordis/lib/types/service.d.ts:13-31`)
and fiber disposal. Anything registered on a service returns a disposer that Cordis
runs on unload.

**Real-world usage check.** The working local plugin
`~/Documents/deepseek-harness/default-workspace/hierarchy-live-test/monitor.js` (33 lines,
mounted in the live `web` profile) uses exactly:
`export const inject = ['agents','subagents']`, `export function apply(ctx, config)`,
and `ctx.on('session/event', (session, event) => …)` at `monitor.js:24`. That is an
existing precedent that `session/event` fires and is usable from a plain plugin.

### 6.1 Write-back observation points (relevant to memory persistence)

`session/event` delivers `SessionEvent` objects whose `type` is `SessionEventType`
(`$PKG/dsh-session/lib/types/types.d.ts:436`). The message-producing subset is declared
as `SurfaceEventType = 'system/message' | 'developer/message' | 'user/message' |
'assistant/message' | 'tool/result'` (`types.d.ts:443`), with per-type payloads at
`:295` (`user/message`), `:331` (`assistant/message`), `:375` (`tool/result`), `:316`
(`system/message`). Turn/step boundaries are observable as `turn/start`, `turn/end`,
`step/start`, `step/end` (`types.d.ts:263-286`).

So a plugin *can* watch the conversation at message granularity without polling — this
is the natural hook for writing durable memories. What it may **not** do is mutate the
prompt in place (§6.2).

### 6.2 Explicitly requested checks — results

The brief asked me to state that three things are *not verifiable*. Two of the three
expectations were wrong, and I am reporting what the installed code proves:

| Claim to check | Verdict | Evidence |
| --- | --- | --- |
| an `agent/pre-step` hook | **VERIFIED TO EXIST** (contrary to the brief's assumption) | `$PKG/dsh-agent/lib/types/runtime-types.d.ts:304`, `@mode waterfall`, returns `Promise<PreStepDecision>` |
| direct `session.systemPrompt` mutation | **DOES NOT EXIST** | `dsh-session/lib/types/types.d.ts:225-228` declares `system?: never` with the comment *"Retired request text; system prompts belong to system/message events."* `RequestContext.systemPromptUpdate` is a **read-only route capability flag** typed `SystemPromptUpdate = 'in-history'` (`dsh-session/lib/types/types.d.ts:239-240`, `$PKG/dsh-llm/lib/types/types.d.ts:382`) describing how a provider reads the system message — not a mutable prompt. `grep -c systemPrompt $PKG/dsh-session/lib/index.js` = **0**. |
| a `/recall` HTTP route | **TECHNICALLY POSSIBLE, not a first-class feature** | `class WebServer extends Service` registered as `"webServer"` (`$PKG/dsh-host-webserver/lib/index.js:286`) exposes `register(route: WebRoute): () => void` where `WebRoute = { kind: 'exact' \| 'prefix', path: string, handler(req,res) }` — `$PKG/dsh-host-webserver/lib/types/index.d.ts:32-43,169-176`. Also `registerUpgrade`, `registerFallback`, `tapIndex`. So a plugin *can* serve `/recall`, but nothing in DSH defines such a route and no recall semantics exist. |

---

## 7. Config / profile mechanism (verified)

A profile is a directory under `$DSH_HOME/profiles/<name>/` containing four files:

| File | Role |
| --- | --- |
| `package.json` | `dsh.profile.bundles: string[]` — ordered bundle packages; also holds `dependencies` (including `link:` deps for local plugins) |
| `cordis.yml` | root entry list, literally `[]`; the header says *"Edit cordis.patch.yml, not this file."* |
| `cordis.patch.yml` | the user's own patch layer |
| `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `node_modules/` | package management for the profile |

The composition order, quoted from the header of `~/.dsh/profiles/web/cordis.patch.yml`:

> *"Your patch layer for this dsh profile, applied after every bundle layer: a
> top-level YAML array of loader patch entries (id-targeted config overrides,
> disables, and insert lists; `!!js` expressions allowed)."*

`dsh --dump-config` prints the composed tree and annotates each row with its origin —
e.g. `# == @deepseek-ai/dsh-base, patched by /Users/varad/.dsh/profiles/web/cordis.patch.yml`.
That is the authoritative way to confirm what a profile actually mounts.

**Patch entry forms verified in the live files:**

1. Override by id (targeted by `id`, re-declaring `name`):
   ```yaml
   - id: agent-default-model
     name: "@deepseek-ai/dsh-agent-default-model"
     config: { provider: ollama-cloud, model: deepseek-v4.1-flash:1017 }
   ```
2. Disable: `disabled: true`, or conditional `disabled: !!js '!ctx.get(''profileContext'')'`.
3. **Insert new plugins** — verified in the working local bundle
   `hierarchy-test-monitor/cordis.patch.yml`:
   ```yaml
   - insert:
       - id: hierarchy-live-monitor
         name: '/absolute/path/to/monitor.js'   # abs path or package name
         config: { ... }
   ```
4. Config values may be `!!js` expressions evaluated at load, including `!!js >-` blocks
   and ternaries over `process.platform` / `process.env` (all observed in the dump).

### 7.1 The patch schema, from the machine-readable source

`dsh --profile web --dump-config-schema` emits a ~981 KB JSON Schema
(*"Describes the parsed entry-list YAML printed by --dump-config. Use `$defs.patchList`
for a profile/home/CLI overlay."*). A trimmed copy is saved at
[`docs/research/patch-schema-excerpt.json`](research/patch-schema-excerpt.json). It states
the layer order authoritatively:

> *"Bundle, profile, home, and CLI layers apply in that order. A patch config replaces the
> whole config."*

A patch entry is exactly `entryMetadata` **plus** an optional `insert`:

| Key | Meaning (schema description) |
| --- | --- |
| `id` | *"Entry id. Loader generates an id when an entry omits it; patches use the configured id."* |
| `name` | *"Plugin module specifier. Inserted relative plugin paths are anchored beside their patch file."* |
| `config` | *"A patch config replaces the whole config"* — it is a **replace, not a deep merge** |
| `disabled` | boolean **or** `!!js` expression |
| `insert` | an `entryList` — the only structural operation |
| `group` | *"Allows patch indexing and insertion into an entry-list config"* |
| `inject` | per-entry override of the plugin's injection list |
| `isolate` | `{ [service]: true \| string }` — per-service isolation |
| `intercept` | object |

Two consequences worth carrying into Phase 1:

- **There is no `remove`/`delete` key.** To take something out of the tree you set
  `disabled: true` (the only structural keys are `insert` and `disabled`). 29 entries in
  the live `web` tree are disabled this way.
- **`config` replaces wholesale.** A patch that sets one field of a plugin's config must
  restate the others, or they fall back to schema defaults.

**Adding a third-party package to a profile** is done through the CLI, which forwards to
pnpm inside the profile directory — `dsh plugin --profile <name> add <pkg>`
(`$DSH/lib/plugin-*.js`; help text: *"manage a profile's plugins by forwarding the
remaining arguments to pnpm in the profile directory"*). Note the profile is initialized
on first use, so a new profile can be bootstrapped with
`dsh <name> --from-default-profile web`.

Full `dsh --help` and `dsh plugin --help` output is recorded verbatim in
[`docs/research/cli-help.txt`](research/cli-help.txt).

---

## 8. MCP client contract (relevant if Cognee exposes MCP)

Verified from `$PKG/dsh-mcp-client/lib/types/index.d.ts`:

- Discriminated on `transport`:
  - `StdioConfig` (`:26-51`): `transport:'stdio'`, `serverName`, `command`, `args[]`,
    `env`, `cwd`, `toolCallTimeoutMs`, `failOnStartupError`, `maxInstructionBytes?`,
    `reconnect?`
  - `StreamableHttpConfig` (`:53-74`): `transport:'streamable-http'`, `serverName`,
    **`url`**, `headers`, `toolCallTimeoutMs`, `failOnStartupError`,
    `maxInstructionBytes?`, `reconnect?`
- `serverName` *"Must match `[A-Za-z0-9_-]{1,32}` and be unique across live mcp-client
  instances"*; it namespaces model-facing tool names as
  **`mcp__<serverName>__<rawName>`**.
- One plugin instance == one MCP server: *"load multiple instances in `cordis.yml` for
  multiple servers"* (`lib/types/index.d.ts:5`). So multiple servers = multiple `insert:`
  rows with distinct `id`s.
- Transport kinds are exactly `'stdio'` and `'streamable-http'` (`transport.d.ts:16`,
  `createTransport`). No plain SSE-only legacy transport.
- `apply(ctx, config): Promise<void>`; `Config: z<ConfigInput, Config>` (`:80,89`).
  Requires peer deps on `dsh-mcp-resources`, `dsh-system-prompt`, `dsh-tools`,
  `dsh-scope`, `dsh-subprocess`, `dsh-timeout`, `dsh-attachment`, `dsh-llm`.

Consequence: **if Cognee exposes an MCP endpoint, integrating it may need zero plugin
code** — just an `insert:` row with `transport: 'streamable-http'` and `url`. Whether
such an endpoint exists is an open blocker (§12).

---

## 9. What a minimal plugin would look like (contract only, not implemented)

Derived strictly from §3/§4/§5; included so the design phase does not re-derive it.
**No source file was created from this.**

```js
// package.json → { "name", "type":"module", "main":"lib/index.js",
//                  "peerDependencies": { "@deepseek-ai/cordis": "~4.0.5" } }
export const name = 'cognee-memory'
export const inject = ['tools', 'systemPrompt']          // + 'webServer' only if serving /recall
export const Config = z.object({ /* schemastery */ })
export function apply(ctx, config) {
  const dispose = ctx.tools.register(defineTool({
    name: '…', description: '…',
    parameters: { /* ParameterSchemaSpec */ },
    output: { schema: { /* JSON Schema */ }, render: (args, value) => [/* ContentBlock[] */] },
    async execute(args, exec) { /* must honor exec.signal */ },
  }))
  const disposeSection = ctx.systemPrompt.section({ name: 'cognee:memory', text: '…' })
  // both disposers are released with the fiber; no manual teardown hook exists
}
```

---

## 10. Upstream documentation findings

<!-- FILLED FROM UPSTREAM FETCH -->

---

## 11. Not verifiable from this environment

- **Upstream web docs UI** (`dsh web` documentation pages) — not inspected; only raw
  Markdown was fetched.
- **Whether the published upstream `master` docs exactly match tag `0.2.1-rc.5`** — the
  docs were fetched from `master`, while the installed code is commit `c3286d37…`.
  Where docs and installed `.d.ts` disagreed, I treated the **installed code as
  authoritative** and said so.
- **Cognee's HTTP/MCP API surface** — out of scope for this phase; no server contacted.
- **Behaviour of `agent/pre-step`'s `PreStepDecision` at runtime** (what a listener may
  legally change) — the return type is declared but I did not trace the loop's
  consumption of it. **UNVERIFIED**: exact semantics/limits of `PreStepDecision`.
- **Whether `ctx.systemPrompt.context()` or `section()` is the better channel for
  injecting recalled memory** — both exist; choosing is a design decision, not a fact.

---

## 12. OPEN BLOCKERS — what the lead must obtain

These block the design phase. I could not resolve them from the installation.

1. **Cognee base URL / port / scheme.** No Cognee endpoint is configured anywhere in
   `~/.dsh` or in the `web` profile; nothing to read. Need host, port, and whether it is
   the `ai-large` (10.20.10.30) or `ai-mid` box.
2. **Cognee auth model.** API key? bearer token? per-tenant? Where should the secret
   live — `$DSH_HOME/.credentials.yaml`, an env var referenced by `!!js`, or the
   profile `config` block? Note `$DSH_HOME/.credentials.yaml` exists and is `0600`, but
   I did **not** read it and no credential-integration API was investigated this phase.
3. **Does Cognee expose an MCP endpoint?** This is the single highest-leverage unknown:
   if yes, §8 says the integration can be config-only (`transport: 'streamable-http'`,
   `url`, `headers`), with no plugin code and no tool-schema work.
   If no, we must write an HTTP client plugin and design the tool `output.schema`.
4. **Which memory operations are in scope** (add / search / recall / cognify / prune) and
   their request/response JSON shapes — needed to author `parameters` +
   `output.schema` and `render`.
5. **Injection channel decision** (design, needs lead sign-off): `systemPrompt.section`
   (static prompt section), `systemPrompt.context` (durable user-role snapshot per turn),
   or a `recall` *tool* the model calls on demand. All three are technically available
   (§4, §5); they have very different token-cost and freshness behaviour.
6. **Is a `/recall` HTTP route actually required?** It is implementable via
   `ctx.webServer.register` (§6.2) but adds an unauthenticated surface on the same
   listener as the GUI (`127.0.0.1:3080` today). Needs an explicit decision, and auth
   design if yes.
7. **Target profile.** The live GUI is the `web` profile; adding the plugin there means
   editing `~/.dsh/profiles/web/` (outside this repo) and restarting the running
   `dsh web` process (PID 56806). Confirm whether Phase 1 may touch that profile or must
   use a throwaway profile (`dsh cognee-dev --from-default-profile web`).

---

## 13. Evidence index

| Artifact | What it proves |
| --- | --- |
| [`docs/research/dump-config-web.yml`](research/dump-config-web.yml) | verbatim composed `web` profile tree, 204 entries, layer annotations |
| [`docs/research/cli-help.txt`](research/cli-help.txt) | `dsh --help`, `dsh plugin --help`, `dsh --profile web --dump-config` header |
| `$DSH/package.json` | version, bin, exports, dependency graph |
| `$PKG/dsh-tools/lib/types/{index,schema}.d.ts` | tool registry + `defineTool` contract |
| `$PKG/dsh-system-prompt/lib/types/index.d.ts` | prompt section/context registry |
| `$PKG/dsh-agent/lib/types/runtime-types.d.ts` | agent lifecycle hooks incl. `agent/pre-step` |
| `$PKG/dsh-session/lib/types/index.d.ts` | session hooks |
| `$PKG/dsh-host-webserver/lib/types/index.d.ts` | route registration |
| `$PKG/dsh-mcp-client/lib/types/index.d.ts` | MCP transports/config |
| `~/.dsh/profiles/{web,desktop}/` | real profile layout + patch syntax |
| `…/hierarchy-test-monitor/cordis.patch.yml` | working `insert:` example |
