# Milestone 10 — egress proof and worker-lifecycle diagnostic

Date: 2026-11-22 UTC. Host `control.nomad.opsc.io`, CT 106 (Cognee), CT 103 (DSH).

## 1. Egress: Cognee model traffic

`/opt/stacks/cognee/.env` on CT 106 (values for keys redacted, names only):

| Variable | Value |
| --- | --- |
| `LLM_PROVIDER` | `custom` |
| `LLM_ENDPOINT` | `http://10.20.10.40:8888/v1` |
| `EMBEDDING_PROVIDER` | `openai_compatible` |
| `EMBEDDING_ENDPOINT` | `http://10.20.10.60:8888/v1` |

Live capture (`tcpdump -ni vmbr0` on the Proxmox host) during a forced ingest
(`POST /api/v1/remember` with a unique document, pipeline `DATASET_PROCESSING_COMPLETED`)
and during the full plugin live suite (8 tests, `remember`/`search`/`forget`):

| Destination | Packets | Meaning |
| --- | --- | --- |
| `10.20.10.60:8888` | 188 | embeddings (local) |
| `10.20.10.15:8000` | 21 | Cognee API (local) |
| `10.20.10.40:8888` | 9 | LLM chat/tool calls (local) |
| any external `:8888` / `:8000` | **0** | — |

Also observed from CT 106 (host network namespace, docker SNAT hides the container IP):
50 packets to `76.76.21.61:443` and 31 to `66.33.60.130:443` (Vercel CDN addresses), in a
window when no model call was in flight, plus DNS via `10.20.10.15:53`. These are **not**
model or embedding traffic; no SNI was recoverable from the capture, and the `cognee` image
contains no telemetry/PostHog hook (`grep -rn posthog /app/cognee` → empty). Reported as
observed, unattributed background HTTPS from the Cognee host.

Plugin source: every outbound call goes through `HttpJsonClient` against the configured
`apiBaseUrl` (`src/adapters/http-client.ts`, `src/settings/url.ts`); the only URL literals in
`src/` are comments/placeholders (`http://host:8000`, `http://localhost`). The optional
LLM extractor refuses non-private targets: `assertPrivateEndpoint`
(`src/memory/extraction.ts`) accepts only loopback and RFC1918 addresses.

## 2. Worker-lifecycle diagnostic (no changes made)

`~/.dsh/sessions/--Users-varad-Documents-deepseek-harness-default-workspace--/<id>/session.v4.jsonl.zstd`

Three children started 2026-11-21 21:54 (`12e4b1aa`, `f2cdf8d9`, `062555a8`) all end in the
same place — 24 records, `turns 1 / steps 1`, `request/context` `provider=unsloth`,
`contextWindow=40704`, then:

```
assistant/attempt finish reason error AUTH "401: Invalid or expired API key"
turn/end reason error AUTH
```

Aggregate over all sessions in that workspace: 17 terminal `AUTH` failures on the
`unsloth`/40704 route, 56 `max-tokens` endings on the same route, 31
`CONTEXT_WINDOW_EXCEEDED`; one long run died at 218 steps with
`pi-ai detected context overflow` (262144 window), and 2 sessions have no `turn/end`
(process killed).

Conclusion: the dominant cause of the repeated child deaths is **provider authentication
failure** on the subagent model route (401 at turn 1, step 1 — no work done, no closing
message), not context exhaustion. Context/turn pressure is the second cause: the subagent
route runs a 40 704-token window with a 4 096-token output cap, and long tasks hit both
`max-tokens` and context overflow. Timeouts were not observed as a terminal reason.
