# dsh-cognee-memory

A DSH (DeepSeek Harness) Cordis plugin project that will give DSH agents a **persistent
memory backed by Cognee** — recall across sessions, and write-back of durable facts.

## Status: PHASE 0 — research only

This repository currently contains **no implementation code**. It holds the verified
research that Phase 1 will be designed against.

- No Cognee server has been contacted.
- Nothing under the DSH installation (`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh`)
  has been modified.
- The live `web` profile under `~/.dsh/profiles/web/` has **not** been modified.

## Read this first

**[`docs/RESEARCH.md`](docs/RESEARCH.md)** — the verified DSH 0.2.1-rc.5 plugin contract:
plugin package shape, tool registration API, system-prompt contribution API, the agent
and session lifecycle hooks that actually exist, the profile / `cordis.patch.yml`
mechanism, and the MCP client config surface. Every claim carries a `file:line` or URL
citation; unproven items are marked **UNVERIFIED** / **NOT FOUND**.

**§12 OPEN BLOCKERS** in that document lists what must be decided or obtained before
implementation can start — most importantly whether Cognee exposes an MCP endpoint
(which would make this a config-only integration) and what its URL/auth are.

## Evidence

| Path | Contents |
| --- | --- |
| [`docs/research/dump-config-web.yml`](docs/research/dump-config-web.yml) | verbatim `dsh --profile web --dump-config` output (204 composed entries) |
| [`docs/research/cli-help.txt`](docs/research/cli-help.txt) | `dsh --version`, `dsh --help`, `dsh plugin --help` |
| [`docs/research/UPSTREAM-NOTES.md`](docs/research/UPSTREAM-NOTES.md) | upstream doc extraction with fetch log |
| [`docs/research/INSTALLED-API.md`](docs/research/INSTALLED-API.md) | installed-package API archaeology |

## Environment (verified)

| Item | Value |
| --- | --- |
| DSH | `0.2.1-rc.5`, commit `c3286d37c37f71b186a7e6647092bf2b56d1d690` |
| Node / npm / pnpm | `v25.4.0` / `11.7.0` / `12.16.1` |
| `DSH_HOME` | `/Users/varad/.dsh` |
| Active profile | `web` (`dsh web`, PID 56806, `127.0.0.1:3080`) |

## Layout

```
docs/
  RESEARCH.md              verified contract + open blockers
  research/
    dump-config-web.yml    composed profile tree (evidence)
    cli-help.txt           CLI help capture (evidence)
    UPSTREAM-NOTES.md      upstream docs extraction
    INSTALLED-API.md       installed-package API archaeology
```
