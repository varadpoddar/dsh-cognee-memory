#!/usr/bin/env node
/**
 * `memory` — operator CLI for the cognee-memory profile layer.
 *
 *   memory import-history [--dry-run|--apply] [--scope name:rawId] [--session <id>]
 *   memory export --scope name:rawId --out bundle.jsonl
 *   memory import --in bundle.jsonl --scope name:rawId [--apply]
 *   memory recall --scope name:rawId --query "<text>"
 *   memory remember --scope name:rawId --text "<fact>"
 *
 * Dry run is the default for every writing command: nothing is written without
 * an explicit `--apply`. Secrets are never printed: the CLI reads its token from
 * the configured environment variable and reports presence only.
 */
import { importBundle, exportScope } from './bundle.js'
import {
  applyHistoryImport,
  loadImportState,
  planHistoryImport,
  resolveImportStatePath,
} from './history-import.js'
import { allowedScopes, createCliRuntime, describeScope, identityForScope, parseScopeArg } from './runtime.js'
import { runQueue } from './queue-cmd.js'
import { runTranscript } from './transcript-cmd.js'
import { MemoryError } from '../errors.js'

export interface CliIo {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
}

interface ParsedArgs {
  readonly command: string
  readonly values: Readonly<Record<string, string>>
  readonly flags: ReadonlySet<string>
}

const VALUE_FLAGS = new Set([
  'scope',
  'out',
  'in',
  'query',
  'text',
  'principal',
  'sessions-dir',
  'state-file',
  'session',
  'allow-scope',
  'limit',
  'limit-sessions',
  'preview',
  'workers',
  'queue-sub',
  'transcript-sub',
  'turns',
])
const BOOLEAN_FLAGS = new Set(['apply', 'dry-run', 'json', 'help', 'from-sessions', 'drain', 'status'])

function parseArgs(argv: readonly string[]): ParsedArgs {
  const command = argv[0] ?? 'help'
  const values: Record<string, string> = {}
  const flags = new Set<string>()
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    if (!arg.startsWith('--')) {
      // `memory queue <enqueue|drain|status>` takes one positional subcommand.
      if (command === 'queue' && values['queue-sub'] === undefined) {
        values['queue-sub'] = arg
        continue
      }
      if (command === 'transcript' && values['transcript-sub'] === undefined) {
        values['transcript-sub'] = arg
        continue
      }
      throw new MemoryError('VALIDATION', `unexpected argument: ${arg}`)
    }
    const key = arg.slice(2)
    if (BOOLEAN_FLAGS.has(key)) {
      flags.add(key)
      continue
    }
    if (!VALUE_FLAGS.has(key)) throw new MemoryError('VALIDATION', `unknown flag: --${key}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new MemoryError('VALIDATION', `--${key} requires a value`)
    }
    values[key] = value
    index += 1
  }
  return { command, values, flags }
}

function integer(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 0) throw new MemoryError('VALIDATION', `not a number: ${value}`)
  return parsed
}

const HELP = [
  'usage: memory <command> [flags]',
  '',
  'commands:',
  '  import-history   scan $DSH_HOME/sessions and ingest explicit facts (dry run by default)',
  '  export           write one scope to a portable JSONL bundle',
  '  import           import a bundle into one authorized scope (dry run by default)',
  '  recall           search one scope and print the records that come back',
  '  remember         write one explicit fact (operator seeding / round-trip proofs)',
  '  queue            durable ingest queue: enqueue | drain | status',
  '  transcript       lossless transcript store: show',
  '',
  'flags: --scope <name:rawId> --apply --dry-run --json --principal <id>',
  '       import-history: --sessions-dir <dir> --state-file <path> --session <id> --limit-sessions N',
  '       queue enqueue: --from-sessions --limit-sessions N --limit N --text "<fact>"',
  '       queue drain:   --workers N --limit N   (endpoints: COGNEE_QUEUE_ENDPOINTS=name=url,...)',
  '       export: --out <path>',
  '       import: --in <path> --allow-scope <name:rawId>[,<name:rawId>]',
  '       recall: --query <text> --limit N',
  '       remember: --text <fact>',
  '       transcript show: --session <id> --turns a..b',
].join('\n')

async function runImportHistory(args: ParsedArgs, env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const runtime = createCliRuntime(env)
  const scope = parseScopeArg(args.values.scope, runtime.config, env)
  const principalId = args.values.principal?.trim() || env.DSH_MEMORY_PRINCIPAL?.trim() || 'dsh-cli'
  const stateFile = args.values['state-file'] ?? resolveImportStatePath(env)
  const sessionsDir = args.values['sessions-dir'] ?? `${env.DSH_HOME?.trim() ?? ''}/sessions`
  const plan = planHistoryImport({
    sessionsDir,
    scope,
    principalId,
    state: loadImportState(stateFile),
    ...(args.values.session === undefined ? {} : { onlySessionId: args.values.session }),
    ...(args.values['limit-sessions'] === undefined
      ? {}
      : { limitSessions: integer(args.values['limit-sessions'], 0) }),
  })
  const apply = args.flags.has('apply') && !args.flags.has('dry-run')
  const previewLimit = integer(args.values.preview, 10)

  if (args.flags.has('json')) {
    const summary = {
      dryRun: !apply,
      scope: describeScope(scope),
      sessionsDir,
      sessions: plan.sessions,
      messages: plan.messages,
      candidates: plan.candidates.length,
      pending: plan.pending.length,
      alreadyImported: plan.alreadyImported,
      byOperation: plan.byOperation,
      namespaces: plan.namespaces,
      dateRange: plan.dateRange,
      skipped: plan.skipped,
      stateFile,
      preview: plan.pending.slice(0, previewLimit).map((entry) => ({
        operation: entry.candidate.operation,
        semanticKey: entry.candidate.semanticKey,
        text: entry.candidate.content,
        sessionId: entry.sessionId,
        messageIndex: entry.messageIndex,
        createdAt: entry.timestamp,
      })),
    }
    if (!apply) {
      io.out(JSON.stringify(summary))
      return 0
    }
  }

  io.out(`scope: ${describeScope(scope)}`)
  io.out(`sessions: ${plan.sessions}  messages: ${plan.messages}  candidates: ${plan.candidates.length}`)
  io.out(
    `operations: ${Object.entries(plan.byOperation)
      .map(([name, count]) => `${name} ${count}`)
      .join('  ') || 'none'}`,
  )
  io.out(`namespaces: ${plan.namespaces.join(', ')}`)
  io.out(
    `date range: ${plan.dateRange === undefined ? 'none' : `${plan.dateRange.from} .. ${plan.dateRange.to}`}`,
  )
  io.out(
    `redaction/skips: secrets ${plan.skipped.secrets}  synthetic ${plan.skipped.synthetic}  tooLong ${plan.skipped.tooLong}  notHuman ${plan.skipped.notHuman}  noCommand ${plan.skipped.noCommand}  malformed ${plan.skipped.malformed}`,
  )
  io.out(`already imported: ${plan.alreadyImported}  pending: ${plan.pending.length}  state: ${stateFile}`)
  if (plan.pending.length === 0) {
    io.out(apply ? 'nothing to ingest' : 'dry run: nothing to ingest')
    return 0
  }
  if (!apply) {
    io.out(`dry run — would ingest ${plan.pending.length} record(s); pass --apply to write`)
    for (const entry of plan.pending.slice(0, previewLimit)) {
      io.out(
        `  - ${entry.candidate.operation} "${entry.candidate.content}"  key=${entry.candidate.semanticKey}  ${entry.sessionId}#${entry.messageIndex}`,
      )
    }
    return 0
  }

  const result = await applyHistoryImport({
    plan,
    coordinator: runtime.coordinator,
    stateFile,
  })
  io.out(
    `applied: ingested ${result.ingested}  deduplicated ${result.deduplicated}  failed ${result.failed}`,
  )
  for (const failure of result.failures) io.err(`failed: ${failure.semanticKey} (${failure.code})`)
  for (const record of result.records) {
    io.out(`  + ${record.recordId} key=${record.semanticKey} "${record.text}"  ${record.sessionId}#${record.messageIndex}`)
  }
  io.out(`state: ${result.stateFile}`)
  return result.failed === 0 ? 0 : 1
}

async function runExport(args: ParsedArgs, env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const runtime = createCliRuntime(env)
  const scope = parseScopeArg(args.values.scope, runtime.config, env)
  const out = args.values.out
  if (out === undefined || out.trim() === '') throw new MemoryError('VALIDATION', '--out is required')
  const result = exportScope({ ledger: runtime.ledger, scope, outPath: out })
  if (args.flags.has('json')) {
    io.out(JSON.stringify({ ...result, scope: describeScope(scope) }))
    return 0
  }
  io.out(`scope: ${describeScope(scope)}`)
  io.out(`records: ${result.count}  wrote: ${result.path}`)
  if (result.skippedSecrets > 0) io.err(`refused ${result.skippedSecrets} record(s) containing secrets`)
  return 0
}

async function runImport(args: ParsedArgs, env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const runtime = createCliRuntime(env)
  const scope = parseScopeArg(args.values.scope, runtime.config, env)
  const input = args.values.in
  if (input === undefined || input.trim() === '') throw new MemoryError('VALIDATION', '--in is required')
  const principal = args.values.principal?.trim()
  // Authorization is the deployment identity's writable set plus explicit
  // operator grants. A bundle can never widen this: its own scope claims are
  // provenance only, and the target scope is the one the caller names.
  const resolved = await runtime.coordinator.resolveIdentity(
    principal === undefined ? {} : { principalId: principal },
  )
  const granted = (args.values['allow-scope'] ?? '')
    .split(',')
    .map((raw) => raw.trim())
    .filter((raw) => raw !== '')
    .map((raw) => parseScopeArg(raw, runtime.config, env))
  const permitted = [...allowedScopes(resolved, runtime.config), ...granted]
  const identity = identityForScope(scope, {
    ...(resolved.principalId === undefined ? {} : { principalId: resolved.principalId }),
  })
  const apply = args.flags.has('apply') && !args.flags.has('dry-run')
  const result = await importBundle({
    bundlePath: input,
    ledger: runtime.ledger,
    coordinator: runtime.coordinator,
    identity,
    scope,
    allowedScopes: permitted,
    apply,
  })
  if (args.flags.has('json')) {
    io.out(JSON.stringify({ ...result, scope: describeScope(scope) }))
    return 0
  }
  io.out(`scope: ${describeScope(scope)}  bundle: ${input}`)
  io.out(
    `${result.dryRun ? 'dry run' : 'applied'}: records ${result.records}  imported ${result.imported}  deduplicated ${result.deduplicated}  conflicts ${result.conflicts}  refused ${result.refused}`,
  )
  for (const outcome of result.outcomes.slice(0, 20)) {
    io.out(`  - ${outcome.outcome} key=${outcome.semanticKey}${outcome.record === undefined ? '' : ` id=${outcome.record}`}`)
  }
  if (result.dryRun) io.out('dry run — pass --apply to write')
  return 0
}

async function runRecall(args: ParsedArgs, env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const runtime = createCliRuntime(env)
  const scope = parseScopeArg(args.values.scope, runtime.config, env)
  const query = args.values.query ?? ''
  if (query.trim() === '') throw new MemoryError('VALIDATION', '--query is required')
  const principal = args.values.principal?.trim()
  const identity = identityForScope(scope, principal === undefined ? {} : { principalId: principal })
  const hits = await runtime.coordinator.recall({
    text: query,
    identity,
    limit: integer(args.values.limit, 5),
  })
  if (args.flags.has('json')) {
    io.out(
      JSON.stringify({
        query,
        scope: describeScope(scope),
        hits: hits.map((hit) => ({
          id: hit.record.id,
          text: hit.record.text,
          score: hit.score,
          createdAt: hit.record.createdAt,
        })),
      }),
    )
    return 0
  }
  io.out(`scope: ${describeScope(scope)}  query: ${query}  hits: ${hits.length}`)
  for (const hit of hits) io.out(`  - ${hit.record.id} score=${hit.score.toFixed(4)} "${hit.record.text}"`)
  return 0
}

async function runRemember(args: ParsedArgs, env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const runtime = createCliRuntime(env)
  const scope = parseScopeArg(args.values.scope, runtime.config, env)
  const text = args.values.text?.trim() ?? ''
  if (text === '') throw new MemoryError('VALIDATION', '--text is required')
  const principal = args.values.principal?.trim()
  const identity = identityForScope(scope, principal === undefined ? {} : { principalId: principal })
  const result = await runtime.coordinator.remember({
    text,
    identity,
    provenance: {
      kind: 'user_explicit',
      source: 'memory-cli',
      recordedAt: new Date().toISOString(),
      evidence: 'operator:memory-cli',
    },
  })
  io.out(`remembered ${result.id} in ${describeScope(scope)}${result.deduplicated ? ' (deduplicated)' : ''}`)
  return 0
}

/** Run the CLI (`argv` is `[command, ...flags]`) and return its exit code. */
export async function runCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  io: CliIo = { out: (line) => process.stdout.write(`${line}\n`), err: (line) => process.stderr.write(`${line}\n`) },
): Promise<number> {
  try {
    const args = parseArgs(argv)
    if (args.flags.has('help') || args.command === 'help') {
      io.out(HELP)
      return 0
    }
    switch (args.command) {
      case 'import-history':
        return await runImportHistory(args, env, io)
      case 'export':
        return await runExport(args, env, io)
      case 'import':
        return await runImport(args, env, io)
      case 'recall':
        return await runRecall(args, env, io)
      case 'remember':
        return await runRemember(args, env, io)
      case 'queue':
        return await runQueue(args, env, io)
      case 'transcript':
        return await runTranscript(args, env, io)
      default:
        io.err(`unknown command: ${args.command}`)
        io.out(HELP)
        return 2
    }
  } catch (error) {
    if (error instanceof MemoryError) {
      io.err(`memory: ${error.code}: ${error.message}`)
      return 1
    }
    const message = error instanceof Error ? error.message : String(error)
    io.err(`memory: ${message}`)
    return 1
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && /(?:^|[/\\])main\.(?:js|ts)$/.test(process.argv[1])
if (invokedDirectly) {
  void runCli(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code
  })
}
