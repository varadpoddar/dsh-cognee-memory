/**
 * `memory queue` — operator surface for the durable ingest pipeline.
 *
 *   memory queue enqueue --from-sessions [--limit-sessions 20] [--limit 500] [--scope name:id] [--dry-run]
 *   memory queue enqueue --text "..." [--scope name:id]
 *   memory queue drain [--workers 2] [--limit 50] [--dry-run] [--json]
 *   memory queue status [--json]
 *
 * Dry run is the default for `enqueue` and `drain`: nothing is written unless
 * `--apply` is passed, matching every other writing command in this CLI.
 *
 * Endpoints: `--workers` is capped by the number of configured targets. Targets
 * come from `COGNEE_QUEUE_ENDPOINTS` (`name=url,name2=url2`) or, when unset, the
 * single configured `apiBaseUrl`. That is what lets two workers drive two
 * model endpoints (one per GPU) without touching the plugin's settings.
 */
import { createMemoryAdapter } from '../adapters/memory-adapter.js'
import { MemoryCoordinator } from '../memory/coordinator.js'
import { MemoryLedger, resolveLedgerPath } from '../memory/ledger.js'
import { scopeKey } from '../memory/scopes.js'
import type { CogneeMemoryConfig } from '../config/schema.js'
import { MemoryError } from '../errors.js'
import type { ScopeRef } from '../types.js'
import { redactForIngest } from '../security/ingest-redaction.js'
import {
  loadMap,
  resolveMapKey,
  resolvePiiMapPath,
  saveMap,
  type DetectionOptions,
} from '../security/pii.js'
import { drainQueue, type DrainEvent, type DrainSummary, type DrainTarget } from '../queue/drain.js'
import { collectTranscriptEntries } from '../queue/producer.js'
import {
  IngestQueue,
  resolveQueuePath,
  type BackoffPolicy,
  type QueueItem,
  type QueueStatus,
} from '../queue/store.js'
import { createCliRuntime, identityForScope, parseScopeArg } from './runtime.js'

/** Where DSH keeps session transcripts for this home. */
function defaultSessionsDir(env: NodeJS.ProcessEnv): string {
  const home = env.DSH_HOME?.trim() || `${env.HOME ?? ''}/.dsh`
  return `${home}/sessions`
}

/** Parse `COGNEE_QUEUE_ENDPOINTS` into named base URLs. */
export function parseEndpointSpecs(raw: string | undefined, fallback: string): { name: string; url: string }[] {
  const value = raw?.trim()
  if (value === undefined || value === '') {
    let name = fallback
    try {
      name = new URL(fallback).host
    } catch {
      // Keep the raw string as the label.
    }
    return [{ name, url: fallback }]
  }
  const specs: { name: string; url: string }[] = []
  for (const part of value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')) {
    const eq = part.indexOf('=')
    if (eq > 0) {
      specs.push({ name: part.slice(0, eq).trim(), url: part.slice(eq + 1).trim() })
      continue
    }
    let name = part
    try {
      name = new URL(part).host
    } catch {
      // Keep the raw string.
    }
    specs.push({ name, url: part })
  }
  return specs.length === 0 ? [{ name: fallback, url: fallback }] : specs
}

/**
 * PII pass configuration. Default is OFF (`COGNEE_PII_ENABLED=false`); set
 * `COGNEE_PII_ENABLED=true` to re-enable. The pass costs an LLM round trip per
 * item, so it is opt-in per deployment rather than default-on.
 *
 * This toggle does not affect stage 1/3: the deterministic shaped-secret scrub
 * is unconditional on the ingest path (see `redactForIngest`), because a leaked
 * live credential in a corpus is an incident rather than a preference. A flag
 * for unredacted secrets would have to be separate and explicit.
 */
export function piiOptionsFromEnv(env: NodeJS.ProcessEnv): DetectionOptions | undefined {
  if (env.COGNEE_PII_ENABLED?.trim() !== 'true') return undefined
  const endpoint = env.COGNEE_PII_ENDPOINT?.trim() || 'http://10.20.10.40:8888/v1'
  const model = env.COGNEE_PII_MODEL?.trim() || 'unsloth/Qwen3.8-27B-GGUF'
  const apiKey = env.COGNEE_PII_API_KEY?.trim() || env.UNSLOTH_LARGE_API_KEY?.trim()
  return { endpoint, model, ...(apiKey === undefined || apiKey === '' ? {} : { apiKey }) }
}

/**
 * Queue lifecycle knobs. Defaults are "wait, do not abandon": unlimited retries
 * with a 1 h cap, fsync on every append, and completed hashes kept 30 days so a
 * replay stays idempotent. Override with the COGNEE_QUEUE_* variables.
 */
export function queueOptionsFromEnv(env: NodeJS.ProcessEnv): {
  readonly backoff: BackoffPolicy
  readonly syncWrites: boolean
  readonly tombstoneRetentionMs: number
} {
  const number = (raw: string | undefined, fallback: number): number => {
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  }
  return {
    backoff: {
      baseMs: number(env.COGNEE_QUEUE_BASE_BACKOFF_MS, 30_000),
      capMs: number(env.COGNEE_QUEUE_MAX_BACKOFF_MS, 60 * 60_000),
      maxAttempts: number(env.COGNEE_QUEUE_MAX_ATTEMPTS, 1_000_000),
    },
    syncWrites: env.COGNEE_QUEUE_SYNC_WRITES?.trim() !== 'false',
    tombstoneRetentionMs: number(env.COGNEE_QUEUE_TOMBSTONE_DAYS, 30) * 86_400_000,
  }
}

/** Build one writer per endpoint, each with its own adapter and ledger handle. */
function buildTargets(config: CogneeMemoryConfig, env: NodeJS.ProcessEnv): DrainTarget[] {
  const specs = parseEndpointSpecs(env.COGNEE_QUEUE_ENDPOINTS, config.apiBaseUrl)
  const pii = piiOptionsFromEnv(env)
  const mapPath = resolvePiiMapPath(env)
  const mapKey = pii === undefined ? undefined : resolveMapKey(env)
  // One map per drain so PERSON_1 means the same person for the whole run.
  const placeholderMap = mapKey === undefined ? undefined : loadMap(mapPath, mapKey)
  return specs.map((spec) => {
    const endpointConfig: CogneeMemoryConfig = { ...config, apiBaseUrl: spec.url }
    const adapter = createMemoryAdapter({ config: endpointConfig, env, endpoint: () => spec.url })
    const ledger = new MemoryLedger({ filePath: resolveLedgerPath(env) })
    const coordinator = new MemoryCoordinator({
      adapter,
      config: endpointConfig,
      endpoint: () => spec.url,
      ledger,
    })
    return {
      name: spec.name,
      write: async (item: QueueItem): Promise<void> => {
        const ref = item.scopeRef
        if (ref === undefined) {
          throw new MemoryError('VALIDATION', 'queue item has no scope reference')
        }
        const identity = identityForScope(ref)
        // Ordered pass: secrets -> PII -> re-scan -> ingest.
        const prepared = await redactForIngest(item.text, {
          ...(pii === undefined ? {} : { pii }),
          ...(placeholderMap === undefined ? {} : { map: placeholderMap }),
          secretMode: 'redact',
        })
        if (mapKey !== undefined && prepared.piiFindings.length > 0) {
          saveMap(mapPath, prepared.map, mapKey)
        }
        await coordinator.remember({
          text: prepared.text,
          identity,
          provenance: {
            kind: 'import',
            source: 'ingest-queue',
            recordedAt: new Date().toISOString(),
            evidence: 'queue:nightly',
            ...(item.source.sessionId === undefined ? {} : { sessionId: item.source.sessionId }),
            ...(item.source.turnIndex === undefined ? {} : { turn: item.source.turnIndex }),
          },
        })
      },
    }
  })
}

export interface QueueCommandIo {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
}

export interface QueueCommandArgs {
  readonly values: Readonly<Record<string, string>>
  readonly flags: ReadonlySet<string>
}

function number(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function describeStatus(status: QueueStatus): string {
  const counts = status.counts
  return [
    `queue: ${status.filePath}`,
    `items ${status.total}  pending ${counts.pending}  inflight ${counts.inflight}  done ${counts.done}  failed ${counts.failed}`,
    `due now ${status.dueNow}${status.nextAttemptAt === undefined ? '' : `  next retry ${status.nextAttemptAt}`}`,
    `log lines ${status.lines}`,
  ].join('\n')
}

/** Entry point for `memory queue <sub>`. */
export async function runQueue(args: QueueCommandArgs, env: NodeJS.ProcessEnv, io: QueueCommandIo): Promise<number> {
  const sub = args.values['queue-sub'] ?? 'status'
  const queue = IngestQueue.open({ filePath: resolveQueuePath(env), ...queueOptionsFromEnv(env) })

  if (sub === 'status') {
    const status = queue.status()
    if (args.flags.has('json')) {
      io.out(JSON.stringify(status))
      return 0
    }
    io.out(describeStatus(status))
    return 0
  }

  if (sub === 'enqueue') {
    const scope = parseScopeArg(args.values.scope, createCliRuntime(env).config, env)
    const entries = [] as ReturnType<typeof collectTranscriptEntries>['entries'][number][]
    const report = { sessions: 0, missing: false, skipped: { synthetic: 0, tooLong: 0, notHuman: 0 } }
    if (args.flags.has('from-sessions')) {
      const produced = collectTranscriptEntries({
        sessionsDir: args.values['sessions-dir'] ?? defaultSessionsDir(env),
        scope: scopeKey(scope),
        ...(args.values['limit-sessions'] === undefined
          ? {}
          : { limitSessions: number(args.values['limit-sessions'], 20) }),
        ...(args.values.limit === undefined ? {} : { limitItems: number(args.values.limit, 500) }),
      })
      if (produced.missing) {
        io.err(`queue: no sessions directory at ${produced.sessionsDir}`)
        return 1
      }
      report.sessions = produced.sessions
      report.skipped = produced.skipped
      entries.push(...produced.entries.map((entry) => ({ ...entry, scopeRef: scope })))
    }
    const text = args.values.text?.trim()
    if (text !== undefined && text !== '') {
      entries.push({ text, scope: scopeKey(scope), scopeRef: scope })
    }
    if (entries.length === 0) throw new MemoryError('VALIDATION', 'nothing to enqueue: pass --from-sessions or --text')
    const apply = args.flags.has('apply')
    const result = queue.enqueue(entries, { dryRun: !apply })
    if (args.flags.has('json')) {
      io.out(JSON.stringify({ ...result, dryRun: !apply, sessions: report.sessions, skipped: report.skipped }))
      return 0
    }
    io.out(
      `${apply ? 'enqueued' : 'dry run'}: added ${result.added}  duplicates ${result.duplicates}  sessions ${report.sessions}`,
    )
    io.out(
      `skipped: synthetic ${report.skipped.synthetic}  tooLong ${report.skipped.tooLong}  notHuman ${report.skipped.notHuman}`,
    )
    if (!apply) io.out('dry run — pass --apply to write')
    return 0
  }

  if (sub === 'drain') {
    const runtime = createCliRuntime(env)
    const targets = buildTargets(runtime.config, env)
    const apply = args.flags.has('apply')
    const limit = args.values.limit === undefined ? undefined : number(args.values.limit, 50)
    const workers = number(args.values.workers, 2)
    if (!apply) {
      const status = queue.status()
      io.out(`dry run: ${status.dueNow} item(s) due across ${targets.length} endpoint(s): ${targets.map((t) => t.name).join(', ')}`)
      io.out(`would drain with ${Math.min(workers, targets.length)} worker(s)`)
      return 0
    }
    const events: DrainEvent[] = []
    const summary: DrainSummary = await drainQueue({
      queue,
      targets,
      workers,
      ...(limit === undefined ? {} : { limit }),
      ...(args.flags.has('json')
        ? {}
        : {
            onEvent: (event: DrainEvent) => {
              events.push(event)
              if (event.type === 'done') io.out(`  ok   ${event.id} via ${event.target} ${event.ms}ms`)
              else if (event.type === 'failed') io.err(`  fail ${event.id} via ${event.target}: ${event.error}`)
            },
          }),
    })
    // A completed task is deleted from the log; only its hash stays (tombstone),
    // so the list holds exactly the work that is not yet fully ingested.
    const pruned = queue.pruneDone()
    if (args.flags.has('json')) {
      io.out(JSON.stringify({ ...summary, pruned }))
      return summary.failed > 0 ? 1 : 0
    }
    io.out(
      `drained: ok ${summary.processed}  failed ${summary.failed}  workers ${Math.min(workers, targets.length)}  ${summary.durationMs}ms`,
    )
    for (const [target, count] of Object.entries(summary.byTarget)) io.out(`  ${target}: ${count}`)
    io.out(`removed ${pruned.removed} completed task(s); ${pruned.remaining} still queued`)
    return summary.failed > 0 ? 1 : 0
  }

  throw new MemoryError('VALIDATION', `unknown queue subcommand: ${sub}`)
}
