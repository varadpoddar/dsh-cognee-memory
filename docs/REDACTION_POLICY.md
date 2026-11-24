# Redaction policy

What leaves this host before a conversation turn becomes a Cognee memory, what
does not, and how to audit it.

Redaction runs in a fixed order (`src/security/ingest-redaction.ts`). The order
is the guarantee: each stage sees the output of the previous one, and the last
step looks at exactly the bytes that would be uploaded.

```
raw text
  -> 1. deterministic secret removal        (src/security/redaction.ts)
  -> 2. LLM PII pass -> stable placeholders (src/security/pii.ts)
  -> 3. re-scan for credentials            (redaction.ts, on the final text)
  -> 4. adapter write (add + cognify)
```

Step 3 is a gate, not a formality: if it still finds credential material the
write is refused (`ResidualSecretError`) rather than shipped.

## Caught

**Stage 1 — shapes.** High-confidence credential formats only, because a
false positive destroys recall and a false negative leaks a key:

| kind | shape |
| --- | --- |
| `private_key` | `-----BEGIN … PRIVATE KEY-----` blocks (PEM, any key type) |
| `api_key` | `sk-`, `rk-`, `pk-` prefixed keys, 24+ chars |
| `github_token` | `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`, `github_pat_` |
| `aws_access_key` | `AKIA…`/`ASIA…` + 16 upper-case alphanumerics |
| `jwt` | three base64url segments starting `eyJ` |
| `bearer_token` | `Bearer <16+ token chars>` |
| `cognee_token` | `cognee_<16+>` |
| `password_assignment` | `password|secret|api_key|token = <8+ non-space>` (placeholders like `$VAR`, `{{…}}`, `[REDACTED` excluded) |

Replacements are `[REDACTED:<kind>]`. In `redactionMode: reject` the write is
refused instead; the message names only the kinds, never the value.

**Stage 2 — LLM PII pass.** The local Qwen model is asked for a JSON list of
entities and exact substrings, restricted to six classes:

| placeholder | catches |
| --- | --- |
| `PERSON_n` | personal names, including third parties in prose |
| `ADDR_n` | postal addresses |
| `PHONE_n` | phone numbers in any format |
| `EMAIL_n` | email addresses |
| `ORG_n` | organisation / employer names |
| `ID_n` | account, ticket, customer ids and handles |

Numbering is **stable per value**, not per occurrence: `Dana Whitfield` becomes
`PERSON_1` in every turn of a batch, so archived text stays coherent and a later
question can still see that one actor did several things. Longest match wins and
replacements never overlap (`Dana Whitfield` is not partially eaten by `Dana`).

## Not caught

State this plainly; the pipeline is lossy and reviewers must know where.

- **Semantically implied identity.** "My manager's wife", "the only SRE on
  call", "our Berlin office" identify people and places without naming them.
  No entity extractor catches this; only a human reading the turn does.
- **Re-identification by combination.** Two innocuous facts (`the person who
  owns the R9700 box` + `joined in March`) can identify someone even when each
  is allowed. Aggregation is out of scope for per-turn redaction.
- **Secrets with no distinctive shape.** A bare 40-char hex string, a password
  that looks like a word, a connection string with credentials in the query. If
  it has no prefix and no assignment, stage 1 misses it and stage 2 is not
  looking for it.
- **Secrets inside files/images.** Only text blocks are redacted. Screenshots,
  PDFs and tool output that is not plain text are not scanned.
- **Model misses and drift.** Stage 2 is a model call: it can miss a name, and a
  changed model or quantisation changes results. Detection quality is measured
  per release (see `docs/REDACTION_RESULTS.md`), not assumed.
- **Placeholder leakage into prose.** The model is told to ignore `KIND_n`
  tokens, but a user who types `PERSON_1` themselves will collide with a real
  mapping. Placeholders are not namespaced per session.
- **Non-text transport.** Anything written by another process straight to
  Cognee bypasses this pipeline entirely.

## The placeholder map

`PlaceholderMap` is the only place the real values live. It is:

- **local only** — written under the plugin state dir
  (`$DSH_HOME/plugins/cognee-memory/pii-map.enc.json`), never into a dataset,
  never into provenance, never into a log line;
- **encrypted at rest** — AES-256-GCM, random IV per save, authenticated
  (`src/security/pii.ts`). The key is `COGNEE_PII_MAP_KEY` (64 hex chars or a
  passphrase stretched with scrypt), or a generated `pii-map.enc.json.key`
  written `0600` on first use;
- **atomic** — temp file plus rename, mode `0600`;
- **fail-closed** — a wrong key or corrupt file yields an *empty* map, so
  numbering restarts and new placeholders are issued rather than silently
  reusing someone else's.

Losing the map is recoverable but lossy: redacted text stays readable and
searchable, but `PERSON_1` can no longer be resolved back to a name. That is the
intended failure direction.

## Review process

1. **Before enabling the PII pass**, run it in observe mode on a real sample and
   read the diff yourself:
   `COGNEE_PII_ENABLED=true memory queue drain --apply --limit 5` then inspect
   with `--json` (counts only) or the redaction test's printed excerpt.
2. **Check the counts, not just the text.** A sudden drop to zero detections on
   text that clearly contains names means the endpoint is down and the pass
   silently no-opped — that is a fail-open path by design (see "Model misses"),
   so it must be noticed in review.
3. **Never paste real values into an issue, commit, or dataset.** Describe the
   class ("a customer id") and the placeholder.
4. **Rotate on suspicion.** If a key may have reached a dataset, rotate the
   credential first, then `forget` the record (prune is cheap and real: it
   deleted 11 nodes and 13 edges in 237 ms in the ingest experiment).

## How to audit

- **What was uploaded**: `GET /api/v1/datasets/{id}/data` lists data ids and a
  content hash per record; the text itself is at
  `/api/v1/datasets/{id}/data/{data_id}/raw`. Grep it for `[REDACTED:` and
  `PERSON_`/`ADDR_` rather than for names.
- **What redaction decided**: `redactForIngest` returns `secretKinds`,
  `piiFindings` (kind + placeholder + value, local only) and
  `residualSecretKinds`. `residualSecretKinds` must always be empty; a non-empty
  value means the write was refused, which is the correct outcome.
- **Per-item trail**: the queue log
  (`$DSH_HOME/plugins/cognee-memory/ingest-queue.jsonl`) records each item's
  state, attempts and last error — never its text.
- **Reproduce the gate**: `npx vitest run test/pii.test.ts` covers ordering,
  stable numbering, encrypted map round-trip, tamper rejection and
  "map is not in the uploaded text"; the live suite adds the real-model run.

## Known gaps to close before relying on this

- The pass is **opt-in** (`COGNEE_PII_ENABLED=true`) and currently applied on the
  queue drain path; the interactive `memory` tool path still uses stage 1 only.
- Detection quality is unmeasured on a labelled corpus; the live run reports
  counts and latency on one real sample only.
- No per-session namespacing of placeholders, so two people can share a number
  across unrelated projects in the same map file.
