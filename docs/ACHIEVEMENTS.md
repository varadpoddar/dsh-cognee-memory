# Achievements — deployed services and where the evidence lives

This is the register of what is running for the dsh-cognee-memory deployment and
the documentation that explains each piece. Addresses are infrastructure facts;
secrets are recorded as **paths and ownership only**, never as values.

## Services

| Service | Address / endpoint | Documentation |
| --- | --- | --- |
| CT101 control node (Proxmox VE, runs every `pct exec`) | `control.nomad.opsc.io` (SSH: `root@control.nomad.opsc.io`, key `~/.ssh/dsh`) | [RUNBOOK.md](docs/RUNBOOK.md) |
| CT102 Technitium DNS | `10.20.10.11` (API `:5380`) | [RUNBOOK.md](docs/RUNBOOK.md) |
| CT103 DeepSeek Harness (`dsh` OS user, original instance) | `10.20.10.12:3080` | [DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| CT103 DeepSeek Harness (`varad` OS user, isolated instance) | `10.20.10.12:3081`, public `https://dsh.nomad.opsc.io` | [VARAD_INSTANCE.md](docs/VARAD_INSTANCE.md) |
| CT104 Traefik ingress | `10.20.10.13` (entry point for `*.nomad.opsc.io`) | [DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| CT105 Docmost | internal LXC on `control` | [RUNBOOK.md](docs/RUNBOOK.md) |
| CT106 Cognee API + UI | `10.20.10.15:8000` (API `/api/v1`), `10.20.10.15:3000` (UI) | [SEAWEEDFS.md](docs/SEAWEEDFS.md), [SUMMARY_PIPELINE.md](docs/SUMMARY_PIPELINE.md) |
| CT107 Hermes | internal LXC on `control` | [RUNBOOK.md](docs/RUNBOOK.md) |
| CT108 Native | internal LXC on `control` | [RUNBOOK.md](docs/RUNBOOK.md) |
| CT109 Infisical | `10.20.10.22` (`:8080`), public `https://infisical.nomad.opsc.io` | [INFISICAL.md](docs/INFISICAL.md) |
| CT120 Unsloth (aimid node, Qwen large) | internal LXC | [RUNBOOK.md](docs/RUNBOOK.md) |
| CT2001 SeaweedFS (aimid node, S3 blob store) | `10.20.10.21`, S3 `:8333`, filer `https://seaweed.nomad.opsc.io`, admin `https://admin-seaweed.nomad.opsc.io` | [SEAWEEDFS.md](docs/SEAWEEDFS.md) |
| CT200 Unsloth-AMD (ailarge node, Qwen `Qwen3.8-27B-GGUF`) | `10.20.10.40:8888` | [RUNBOOK.md](docs/RUNBOOK.md) |
| Embeddings service | `10.20.10.60:8888` | [RUNBOOK.md](docs/RUNBOOK.md) |

Cognee on CT106 is **S3-backed by SeaweedFS on CT2001**; the Cognee dataset for
the varad instance is `dsh-project-varad-mac-history-5c5a11e6b8d6859e32a4`
(dataset id `09ad23d9-2b35-5692-abb2-c4077b477d05`). The Cognee pipeline and its
queue are documented in [SUMMARY_PIPELINE.md](docs/SUMMARY_PIPELINE.md) and
[INGEST_PIPELINE.md](docs/INGEST_PIPELINE.md).

## Secrets (paths and ownership only)

Values are never recorded in this repository or in this document.

| Path | Owner / mode | Purpose |
| --- | --- | --- |
| `/etc/dsh/cognee.env` | `0640 root:dsh` | `dsh` instance: Cognee API key and settings token |
| `/etc/dsh-varad/varad.env` | `0640 root:varad` | `varad` instance: Cognee API key, settings token, S3 credentials |
| `/etc/dsh/llm.env` | `0640 root:varad` | Qwen / Unsloth API keys used by summaries and extraction |
| `/opt/stacks/cognee/.env` | `0600 root` | Cognee container environment on CT106 |
| `/root/infisical-admin` | `0600 root` | Infisical admin credential (root-only on CT109) |
| `/root/seaweedfs-creds` | `0600 root` | SeaweedFS S3 credentials (root-only on the aimid node) |

Rotation and permission checks live in [RUNBOOK.md](docs/RUNBOOK.md); the
redaction rules for anything that reaches memory are in
[REDACTION_POLICY.md](docs/REDACTION_POLICY.md).

## Backups and rollback

| Artifact | Location |
| --- | --- |
| Cognee pre-S3-reset backups | `/root/backups/cognee-pre-s3-reset-*` on CT103 |
| DSH pre-reset backups | `/root/backups/dsh-pre-reset-*` on CT103 |

Backup procedure: [BACKUP.md](docs/BACKUP.md). Restore drill:
[RESTORE.md](docs/RESTORE.md). Rollback of a plugin release:
[ROLLBACK.md](ROLLBACK.md). Day-2 operations:
[RUNBOOK.md](docs/RUNBOOK.md).

## Memory pipeline

- **Lossless transcripts** — 699 files / 1,772 rows under
  `/home/varad/.dsh/plugins/cognee-memory/transcripts/`; format and replay in
  [TRANSCRIPTS.md](docs/TRANSCRIPTS.md).
- **Turn journal** — every user and agent part becomes a durable ingest task,
  deleted only after a complete ingest: [TURN_JOURNAL.md](docs/TURN_JOURNAL.md).
- **Segment summaries** — one summary per deterministic turn segment, rendered
  with a `[[dsh-memory-pointer …]]` header that joins it to the exact
  transcript range: [SUMMARY_PIPELINE.md](docs/SUMMARY_PIPELINE.md).
- **Durable queue** — `ingest-queue.jsonl` under the same plugin directory,
  drained through Cognee `/add` + `/cognify`:
  [INGEST_PIPELINE.md](docs/INGEST_PIPELINE.md).
- **Model-facing recall** — bounded `Known context:` lines with scope, date and
  a per-memory panel link: [ARCHITECTURE.md](docs/ARCHITECTURE.md),
  [MEMORY_LINKING.md](docs/MEMORY_LINKING.md).

## Documentation memory

These docs are also **ingested into the varad instance's Cognee memory**, so a
service question ("where is SeaweedFS hosted, what IP and S3 endpoint does it
use?") is answered from the written truth. The addresses were discovered at
deploy time and never appear in a conversation turn — one of them occurs 0× in
1,772 stored turns — so summaries alone cannot answer it, and older summaries
still carry a stale plan that put Infisical on `10.20.10.21`.

- **Documents** — the nine files in this directory
  (`ACHIEVEMENTS.md`, `SEAWEEDFS.md`, `INFISICAL.md`, `BACKUP.md`, `RESTORE.md`,
  `RUNBOOK.md`, `SUMMARY_PIPELINE.md`, `TRANSCRIPTS.md`, `TURN_JOURNAL.md`),
  copied to `/home/varad/.dsh/docs/` on CT 103.
- **Chunking** — one memory per H2 section, plus one per row of the service and
  secret tables in this file, because a register row *is* the retrievable fact.
  Every chunk starts with `# <file> · <section>` and is stored with a
  `[[dsh-memory-pointer …]]` header whose session id is `doc:<file>`. The
  model-visible `Known context:` line is the first ~240 characters of the
  chunk, which is why an address or a credential path leads its own chunk.
- **Path** — `scripts/ingest-docs.mjs` builds the chunks and enqueues them with
  `kind: "summary"` into the durable ingest queue. The normal drain batches them
  through Cognee `/add` + `/cognify` (the 1.0.9 batched path), so redaction,
  dedupe, the provenance index and the ledger row are the ones every memory
  gets. Target scope `project:varad/mac-history` →
  `dsh-project-varad-mac-history-5c5a11e6b8d6859e32a4`.

**Re-ingest after an edit.** Copy the edited markdown into
`/home/varad/.dsh/docs/` and run, as `varad`:

```bash
su -s /bin/bash varad -c 'set -a; . /etc/dsh-varad/varad.env; set +a; \
  export DSH_HOME=/home/varad/.dsh; \
  node /home/varad/.dsh/scripts/ingest-docs.mjs --docs /home/varad/.dsh/docs --apply'
```

The script is a dry run by default (it prints the chunk plan). An unchanged
chunk is skipped (`added: 0`); an edited one is enqueued again under the same
section key and the drain ingests it. Superseded chunks stay in place — memory
is append-only — and the newest version wins at retrieval.

**Verified 2026-11-25.** The injected `Known context:` block for the SeaweedFS
question carried `10.20.10.21`, `S3 :8333` and `/root/seaweedfs-creds`; the
Infisical question carried `10.20.10.22` and `:8080`. Every line ended with its
per-memory panel link under
`https://dsh.nomad.opsc.io/plugins/cognee-memory/memory/…`. Full four-question
evidence, including the one question that still does *not* pass (ordered
history), is in [ACCEPTANCE.md](docs/ACCEPTANCE.md).

## Related design records

[COGNEE_DECISIONS.md](docs/COGNEE_DECISIONS.md),
[CONVERSATION_SUMMARIES.md](docs/CONVERSATION_SUMMARIES.md),
[EVALUATION.md](docs/EVALUATION.md),
[REGRESSION_MATRIX.md](docs/REGRESSION_MATRIX.md).
