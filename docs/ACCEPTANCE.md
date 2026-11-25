# Acceptance evidence — the four questions

The acceptance bar for this plugin was never "did `memory_remember` get called"
or "could the next step see something". It is that a *cold* agent, given only a
question, answers it correctly **and** cites a range it can open.

The test below is deliberately run outside the agent loop, against the live
service, so it cannot be satisfied by prompt injection or by the model's own
recollection of the session:

```bash
# on CT 103, as root (needs /etc/dsh/cognee.env)
cd /home/varad
set -a; . /etc/dsh/cognee.env; set +a
export HOME=/home/varad
node /home/varad/verify-docs-recall.mjs "<question 1>" "<question 2>"
```

The script builds the real `RecallService`, the real config, the real
`buildMemoryContextBlock()` — the same block the `system-prompt/assemble` hook
injects — and prints it verbatim.

## Results, 2026-11-25 09:15 PT

| # | Question | Hits | Retrievable answer | Verdict |
|---|---|---|---|---|
| 1 | Where is SeaweedFS hosted, what IP and S3 endpoint does it use, and where are its credentials stored? | 8, 477 ms | `aimid` (10.20.10.20), **CT 2001**, 3.5 TiB of the 8 TB SSD, `S3_ENDPOINT_URL=http://10.20.10.21:8333`, creds **`/root/seaweedfs-creds` (0600)** inside CT 2001 | **pass** |
| 2 | Where is Infisical hosted and what is its IP? | 8, 193 ms | **CT 109**, `10.20.10.22:8080` native package, Traefik `Host(infisical.nomad.opsc.io)`, PostgreSQL 17.12 alongside | **pass** |
| 3 | Which credentials were created for SeaweedFS and for Infisical, and exactly where is each one stored? | 8, 290 ms | `/root/seaweedfs-creds` (0600, CT 2001); `/root/infisical-admin` (0600, control); `/etc/dsh/cognee.env` (0640 root:dsh); `/etc/dsh-varad/varad.env` (0640 root:varad); table of **37 secrets** under `dsh-infra`/`prod` | **pass** |
| 4 | What work was performed on this cluster, and in what order did it happen? | 8, 192 ms | topically relevant narration, **not** a chronological sequence | **partial** |

Every line in the injected block ends with its own URL under
`https://dsh.nomad.opsc.io/plugins/cognee-memory/memory/<id>`, and that page
renders a **Source** section resolving the pointer back to
`session / turn / char range`. Q1–Q3 therefore satisfy the full bar: correct
fact, plus a range the reader can open.

## Why questions 1–3 needed the documents

The Infisical address was chosen during deployment. It appears **0 times** in
1,772 stored conversation turns, and the corpus still contains an older plan
that put Infisical on `10.20.10.21` — the SeaweedFS address. An agent recalling
only conversations restates that stale plan confidently. That is a *source*
gap, not a redaction bug: no amount of retrieval can return a fact that was
never recorded.

Fix: the `docs/` markdown is ingested as memory too, chunked by H2 section (see
[ACHIEVEMENTS.md](ACHIEVEMENTS.md#documentation-memory),
`scripts/ingest-docs.mjs`). A register row becomes its own retrievable chunk,
which is why the address or credential path leads the visible line.

## Open gap — question 4 (ordering)

Recall is semantic only. `searchType: "CHUNKS"` ranks by vector distance, so
"what work was done, in what order" returns the eight *most similar* narration
summaries, not a timeline, and neighbouring hits can come from unrelated work.

What exists to fix it:

- every summary and every transcript row carries `session_id` and `turn_index`,
  and transcript rows carry `timestamp` and `char_start`/`char_end`;
- the pointer payload already travels with each hit, so ordering the hit set is
  a matter of using fields that are already in hand.

What it needs: an ordering/aggregation mode selected by intent — for "in what
order", "timeline", "history" questions, sort by `(timestamp, turn_index)`
within a session and concatenate consecutive ranges instead of ranking by
distance; optionally a per-day rollup memory so a long arc is one hit. Not
implemented; tracked as backlog, not claimed.

## Reproduce the limits honestly

- **Recall is bounded by ingest.** Summaries for ~918 of 1,331 segments were
  still being computed at the time of this run (~35 s per segment, model-bound),
  and queue depth was 537 pending. Facts in unsummarised turns are reachable
  through the transcript store and the panel, but are not in the semantic index.
- **The Mac's live GUI is not journaled.** The plugin runs on CT 103; the
  conversation in `~/.dsh` on this workstation has no plugin installed, so this
  session itself is not in the corpus.
- **Model saturation shows up as latency, not correctness.** Two reconcile items
  failed with `summary model request failed` under load; the reconciler is
  resumable and skips already-enqueued segments, so a re-run retries only those.
