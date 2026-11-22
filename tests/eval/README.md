# `tests/eval/` — Milestone 11 evaluation harness (narrow slice)

Repeatable measurement of the persistent-memory milestone against the live
deployment. Everything here is an **evaluation tool**, not part of the plugin
runtime. The shipped unit/live suites live under `test/`; this directory only
produces the report in [`docs/EVALUATION.md`](../../docs/EVALUATION.md).

## Scope

Scenarios A–E, K, N, O, plus the six metrics (first-turn recall, recall latency,
write-to-retrievable, duplicate rate, cross-scope leakage, injected-token
overhead) and the no-memory baseline. G/H/L are out of scope for this slice.

## Isolation rules (hard)

* Every scope carries the run id: `dsh/eval/<run-id>` and `dsh/eval/<run-id>-other`.
* The fixture scopes `dsh/project/e2e`, `dsh/agent/smoke`, and any dataset without
  the run id are **never** written to, read as evidence, or deleted.
* `--mode cleanup` deletes exactly the datasets this run created (computed from
  `scopeKey`), nothing else.
* No secret is read into a report: the Cognee key and the settings token stay in
  the process environment / `/etc/dsh/*.env` on the host and are never echoed.

## Files

| File | Runs where | Purpose |
| --- | --- | --- |
| `run-eval.mjs` | CT 103 (harness host), as root | Seeds isolated memories, runs A–E, K, N, O, and measures latency, write-to-retrievable, duplicate, leakage and baseline metrics. Writes `report-part1.json`. `--mode cleanup` removes this run's datasets. |
| `check-backend-restart.mjs` | operator machine | Scenario F: `docker restart cognee` on CT 106, waits for `/health`, then asks a fresh harness process for a pre-restart memory. |
| `render-report.mjs` | anywhere | Merges report fragments, prints/writes the markdown report. |

## Running

```bash
# 1) harness-side scenarios + metrics (on CT 103, as root)
su -c 'set -a; . /etc/dsh/cognee.env; . /etc/dsh/llm.env; set +a; \
  node tests/eval/run-eval.mjs --run-id m11-<stamp> \
    --plugin-dir /var/lib/deepseek-harness/.dsh/profiles/headless/node_modules/dsh-cognee-memory/lib \
    --work-dir /tmp/m11-eval --out /tmp/m11-eval/report-part1.json'

# 2) backend restart (from the operator machine)
DSH_SSH_KEY=~/.ssh/dsh node tests/eval/check-backend-restart.mjs --run-id m11-<stamp> \
  --out /tmp/m11-eval/report-backend-restart.json

# 3) render
node tests/eval/render-report.mjs --in /tmp/m11-eval/report-part1.json \
  --in /tmp/m11-eval/report-backend-restart.json \
  --out docs/EVALUATION.md

# 4) cleanup (only this run's datasets)
node tests/eval/run-eval.mjs --run-id m11-<stamp> --mode cleanup
```

## Report fragment schema

```json
{
  "runId": "m11-…",
  "generatedAt": "ISO-8601",
  "environment": { "harness": "…", "plugin": "…", "cognee": "…", "model": "…" },
  "scenarios": [{ "id": "A", "title": "…", "status": "PASS|FAIL|BLOCKED|SKIP",
                  "summary": "…", "evidence": "raw text", "commands": ["…"] }],
  "metrics": { "recallLatencyMs": { "n": 20, "p50": 0, "p95": 0, "max": 0 } },
  "notes": ["…"]
}
```

The renderer prints only numbers present in the JSON — a missing measurement is
shown as `-1` in the fragment and must be explained in a note, never guessed.
