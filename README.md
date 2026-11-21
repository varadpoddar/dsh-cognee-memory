# dsh-cognee-memory

A DSH (DeepSeek Harness) Cordis plugin that gives agents **persistent memory
backed by Cognee** — bounded recall injected as untrusted prompt context, plus
explicit remember/forget/status tools and authoritative task-outcome write-back.

## Status: PHASE 1 — scaffold + core architecture + unit tests

Version `0.1.0`. The package builds and tests with mocks only:

- No Cognee server has been contacted (not `10.20.10.15:8000`, not any other).
- Nothing under `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh` or `~/.dsh`
  has been modified.
- No profile has been mounted yet; that is Phase 3.
- Cognee 1.6 REST paths and MCP tool names are **UNVERIFIED** and isolated in
  [`src/adapters/cognee-paths.ts`](src/adapters/cognee-paths.ts). See
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §5.1.

## Read first

- **[`docs/RESEARCH.md`](docs/RESEARCH.md)** — verified DSH 0.2.1-rc.5 plugin
  contract with `file:line` citations.
- **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — Phase 1 design, security
  model, unverified API list, and the Phase 2–8 roadmap.

## What works today

| Area | Behavior |
| --- | --- |
| Plugin | ESM Cordis plugin: `name`, `inject = ['tools','systemPrompt']`, zod `Config`, `apply()` |
| Tools | `memory_recall`, `memory_remember`, `memory_forget`, `memory_status`, typed params/output, structured errors, full dispose |
| Prompt | Per-agent `ctx.systemPrompt.context()` block, bounded by items/tokens, explicitly untrusted, injection-neutralized, silently degrades |
| Memory | Stable hashed scopes (session/agent/project/team/global), deny-by-default filtering, exact + near dedup, retention planning |
| Security | env-only tokens, header/endpoint redaction, pre-write credential rejection/redaction |
| Transports | Cognee REST and Streamable-HTTP MCP adapters with timeouts, retries/backoff, circuit breaker; `auto` resolution; `mcp-stdio` reserved |
| Tests | Vitest: 25 files, 206 tests; mock HTTP server and fake adapters only |

## Build and test

Requires Node >= 22 and pnpm.

```bash
pnpm install
pnpm build       # strict tsc, ESM declarations to lib/
pnpm test        # vitest run — 25 files / 206 tests
pnpm typecheck   # tsc --noEmit
```

## Configuration sketch

```yaml
- insert:
    - id: cognee-memory
      name: dsh-cognee-memory
      config:
        enabled: true
        transport: auto
        apiBaseUrl: http://127.0.0.1:8000
        # mcpUrl: http://127.0.0.1:8000/mcp
        authMode: none              # none | bearer | api-key
        apiTokenEnv: COGNEE_API_TOKEN
        failureMode: open           # open: prompt recall degrades; closed: surface errors
```

Secrets are read **only** from the configured environment variable. Do not put
tokens in YAML. Do not overwrite a profile's `cordis.patch.yml`; merge an
`insert:` entry instead (see `docs/RESEARCH.md` §7).

## Evidence

| Path | Contents |
| --- | --- |
| [`docs/RESEARCH.md`](docs/RESEARCH.md) | verified DSH plugin contract + open blockers |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Phase 1 architecture + limitations |
| [`docs/research/`](docs/research/) | verbatim `--dump-config`, CLI help, patch schema, upstream docs |

## Roadmap

Phases 2–8 (backend verification, throwaway-profile integration, authoritative
task write-back, prune/retention, prompt tuning, health endpoint, release) are
listed in `docs/ARCHITECTURE.md` §8.
