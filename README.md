# dsh-cognee-memory

A DSH (DeepSeek Harness) Cordis plugin that gives agents **persistent memory
backed by Cognee** — bounded recall injected as untrusted prompt context, plus
explicit remember/forget/status tools and authoritative task-outcome write-back.

## Status: live-verified against Cognee 1.6.10-local

Version `0.1.0`. The REST adapter is verified against the real instance at
`http://10.20.10.15:8000/api/v1` (Cognee `1.6.10-local`, Postgres + pgvector,
`ENABLE_BACKEND_ACCESS_CONTROL=true`) and is installed in the real DSH
`0.2.1-rc.5` profile on CT 103. Every request/response shape in
[`src/adapters/cognee-paths.ts`](src/adapters/cognee-paths.ts) was observed, not
assumed:

- writes are multipart `/remember` calls addressed by **dataset UUID** (a
  `datasetName` the caller does not own would silently create a new dataset);
- ingestion completion is derived from `status/memory` +
  `status?pipeline=cognify_pipeline`, never from a 2xx;
- recall uses `/search` with `datasetIds`, a `maxRecallLatencyMs` budget, and
  degrades to no hits in `open` failure mode.

Evidence: [`docs/LIVE_INTEGRATION.md`](docs/LIVE_INTEGRATION.md) (commands,
redacted payloads, timings, E2E) and [`docs/TEST_RESULTS.md`](docs/TEST_RESULTS.md).

## Read first

- **[`docs/RESEARCH.md`](docs/RESEARCH.md)** — verified DSH 0.2.1-rc.5 plugin
  contract with `file:line` citations.
- **[`docs/COGNEE_DECISIONS.md`](docs/COGNEE_DECISIONS.md)** — Cognee API/auth
  decision matrix.
- **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — design, security model,
  roadmap.
- **[`docs/LIVE_INTEGRATION.md`](docs/LIVE_INTEGRATION.md)** — live verification
  and the CT 103 install/E2E record.

## What works today

| Area | Behavior |
| --- | --- |
| Plugin | ESM Cordis plugin: `name`, `inject = ['tools','systemPrompt']`, zod `Config` (Standard Schema), `apply()` |
| Tools | `memory_recall`, `memory_remember`, `memory_forget`, `memory_status` — verified registered and executed by a real DSH agent |
| Prompt | Per-agent `ctx.systemPrompt.context()` block, bounded by items/tokens, explicitly untrusted, injection-neutralized, silently degrades |
| Memory | Stable hashed scopes (session/agent/project/team/global), deny-by-default filtering, exact + near dedup, retention planning |
| Datasets | Create-if-missing by name, `ownerId` verified against `/users/me`, UUID cached and reused; no name-only writes |
| Ingestion | Polls memory + cognify pipeline status under `ingestion.timeoutMs` before a write is reported complete |
| Security | env-only tokens (`COGNEE_API_KEY`), header/endpoint redaction, pre-write credential rejection/redaction |
| Transports | Verified Cognee REST adapter; Streamable-HTTP MCP adapter kept as an unverified alternative |
| Tests | Vitest: 25 files / 209 unit tests + 8 live tests (`test/live`, skipped without `COGNEE_API_KEY`) |

## Build and test

Requires Node >= 22 and pnpm.

```bash
pnpm install
pnpm build       # strict tsc, ESM declarations to lib/
pnpm test        # vitest run — 25 files / 209 tests
pnpm typecheck   # tsc --noEmit
COGNEE_API_KEY=... npm run test:live   # real HTTP against the live backend
```

## Configuration sketch

```yaml
- insert:
    - id: cognee-memory
      name: dsh-cognee-memory
      config:
        enabled: true
        transport: rest
        apiBaseUrl: http://10.20.10.15:8000/api/v1
        authMode: api-key            # none | bearer | api-key
        apiTokenEnv: COGNEE_API_KEY
        failureMode: open            # open: prompt recall degrades; closed: surface errors
        scopeDefaults:
          projectId: dsh/project/e2e
        recall:
          searchType: CHUNKS         # CHUNKS 0.2 s / GRAPH_COMPLETION ~4-6 s
          maxRecallLatencyMs: 3000
        ingestion:
          timeoutMs: 180000
          pollMs: 500
```

Secrets are read **only** from the configured environment variable. On CT 103 the
key lives in `/etc/dsh/cognee.env` (mode 0600) referenced by a systemd drop-in,
never in YAML or git. Do not overwrite a profile's `cordis.patch.yml`; merge an
`insert:` entry instead (see `docs/RESEARCH.md` §7).

## Evidence

| Path | Contents |
| --- | --- |
| [`docs/RESEARCH.md`](docs/RESEARCH.md) | verified DSH plugin contract + open blockers |
| [`docs/COGNEE_DECISIONS.md`](docs/COGNEE_DECISIONS.md) | Cognee auth/API/ACL decision matrix |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | architecture + limitations |
| [`docs/LIVE_INTEGRATION.md`](docs/LIVE_INTEGRATION.md) | live probes, install path, E2E steps 10–13 |
| [`docs/TEST_RESULTS.md`](docs/TEST_RESULTS.md) | measured unit + live numbers |
| [`docs/research/`](docs/research/) | verbatim `--dump-config`, CLI help, patch schema, upstream docs |

## Roadmap

Remaining work is listed in `docs/ARCHITECTURE.md` §8; the near-term items are
prune/retention execution, a health endpoint for the UI, and prompt tuning on
real sessions.
