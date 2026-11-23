import os from 'node:os'
import path from 'node:path'
import type { CogneeMemoryConfig } from '../config/schema.js'
import { isMemoryError } from '../errors.js'
import { provenanceFromSessionEvent } from './provenance.js'
import type { Metrics } from '../telemetry/metrics.js'
import type { CallerIdentity, MemoryScope } from '../types.js'
import { CandidateQueue, type CandidateQueueStatus } from './candidate-queue.js'
import { Outbox, type OutboxStatus } from './outbox.js'
import {
  extractDeterministicCandidates,
  extractWithLlm,
  type ExtractionInput,
  type MemoryCandidate,
} from './extraction.js'
import type { MemoryCoordinator } from './coordinator.js'
import { scopeFromName, scopeKey } from './scopes.js'

export interface ExtractionTurnInput {
  readonly sessionId: string
  readonly agentPreset?: string
  readonly turn: number
  readonly messages: readonly { readonly text: string; readonly seq?: number }[]
}

export interface ExtractionSnapshot {
  readonly enabled: boolean
  readonly deterministic: boolean
  readonly llmEnabled: boolean
  readonly autoWrite: boolean
  readonly scope: string
  readonly queue: CandidateQueueStatus
  readonly outbox: OutboxStatus
  /** Read-only candidate queue view for the settings page (bounded, redacted). */
  readonly pendingCandidates: readonly PendingCandidateView[]
  readonly lastCandidates: readonly MemoryCandidate[]
  readonly lastError?: string
}

export interface PendingCandidateView {
  readonly id: string
  readonly idempotencyKey: string
  readonly operation: string
  readonly semanticKey: string
  readonly preview: string
}

export interface ExtractionServiceOptions {
  readonly coordinator: Pick<MemoryCoordinator, 'resolveIdentity' | 'remember' | 'forgetByText'>
  readonly config: CogneeMemoryConfig
  readonly metrics?: Metrics
  readonly env?: NodeJS.ProcessEnv
  readonly queue?: CandidateQueue
  readonly outbox?: Outbox
  readonly fetchImpl?: typeof fetch
}

function queueDir(config: CogneeMemoryConfig, env: NodeJS.ProcessEnv): string {
  if (config.extraction.queue.dir !== undefined) return config.extraction.queue.dir
  const home = env.DSH_HOME?.trim()
  return path.join(home === undefined || home === '' ? path.join(os.homedir(), '.dsh') : home, 'cognee-memory')
}

function outboxDir(config: CogneeMemoryConfig, env: NodeJS.ProcessEnv): string {
  if (config.outbox.dir !== undefined) return config.outbox.dir
  return queueDir(config, env)
}

/**
 * Turns committed user turns into durable candidates, spools them, and drains
 * the outbox into the coordinator. It runs even when the agent has no tools:
 * registration does not depend on `tools.enabled`.
 *
 * Every durable write goes through `Outbox`: the candidate spool records what
 * was *meant* to be remembered, the outbox records the *operation* and proves
 * completion only after the coordinator's ingestion gate returns a backend
 * record reference. A crash mid-write leaves `processing`, and `start()`
 * re-queues it once the lease expires.
 */
export class ExtractionService {
  private readonly coordinator: ExtractionServiceOptions['coordinator']
  private readonly config: CogneeMemoryConfig
  private readonly metrics: Metrics | undefined
  private readonly queue: CandidateQueue
  private readonly outbox: Outbox
  private readonly fetchImpl: typeof fetch | undefined
  private readonly env: NodeJS.ProcessEnv
  private lastCandidates: readonly MemoryCandidate[] = []
  private lastError: string | undefined
  private readonly previous = new Map<string, MemoryCandidate[]>()
  /** Bounded, per-session background LLM passes awaited after the response. */
  private readonly llmTasks = new Map<string, Promise<void>>()
  /** One settle budget per turn, shared by the stream hook and the fallback. */
  private readonly settleDeadlines = new Map<string, number>()
  /** Deferred passes staged by `handleTurn`; started only by `settle()` (post-response). */
  private readonly stagedLlm = new Map<
    string,
    {
      readonly inputs: readonly ExtractionInput[]
      readonly resolved: CallerIdentity
      readonly scopeName: Exclude<MemoryScope, 'session' | 'global'>
      readonly scopeKeyValue: string
    }
  >()

  constructor(options: ExtractionServiceOptions) {
    this.coordinator = options.coordinator
    this.config = options.config
    this.metrics = options.metrics
    const env = options.env ?? process.env
    this.env = env
    this.queue =
      options.queue ??
      new CandidateQueue({
        dir: queueDir(options.config, env),
        maxPending: options.config.extraction.queue.maxPending,
      })
    this.outbox =
      options.outbox ??
      new Outbox({
        dir: outboxDir(options.config, env),
        maxAttempts: options.config.outbox.maxAttempts,
        baseBackoffMs: options.config.outbox.baseBackoffMs,
        maxBackoffMs: options.config.outbox.maxBackoffMs,
        leaseMs: options.config.outbox.leaseMs,
        ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
      })
    this.fetchImpl = options.fetchImpl
  }

  get queueFile(): string {
    return this.queue.filePath
  }

  get outboxFile(): string {
    return this.outbox.filePath
  }

  /** Retry anything a previous process left queued. Safe to call once at plugin load. */
  async start(): Promise<void> {
    if (!this.config.extraction.enabled) return
    const recovered = await this.outbox.recover()
    if (recovered.recovered > 0) this.metrics?.increment('retry.attempts', recovered.recovered)
    await this.drainQueue()
  }

  /**
   * One accepted candidate becomes one outbox operation, then the outbox drives
   * the write. Outcomes are folded back into the candidate spool so
   * `memory_status` and the settings page never show a completed write as
   * "queued".
   */
  private async drainQueue(resolvedIdentity?: CallerIdentity, scopeNameInput?: string): Promise<void> {
    const identity = resolvedIdentity ?? (await this.coordinator.resolveIdentity({}))
    if (identity.principalId === undefined || identity.principalId === '') return
    const scopeName =
      scopeNameInput ?? (this.config.extraction.scope as Exclude<MemoryScope, 'session' | 'global'>)
    const scope = scopeFromName(scopeName, identity, this.config)
    if (scope === undefined) return
    const dataset = scopeKey(scope)
    const pending = await this.queue.pending()
    for (const candidate of pending) {
      await this.outbox.enqueue({
        idempotencyKey: candidate.idempotencyKey,
        dataset,
        operation: candidate.operation,
        content: candidate.content,
        candidateVersion: 1,
      })
    }
    const byKey = new Map(pending.map((candidate) => [candidate.idempotencyKey, candidate]))
    await this.outbox.drain(async (operation) => {
      const candidate = byKey.get(operation.idempotencyKey)
      if (candidate === undefined) {
        return { status: 'failed', reason: 'CANDIDATE_MISSING', retryable: false }
      }
      try {
        if (candidate.operation === 'forget') {
          await this.coordinator.forgetByText({
            text: candidate.content,
            identity,
            scopeName,
          })
          this.metrics?.increment('extraction.ingested')
          return { status: 'complete', dataRef: `cognee:${operation.dataset}#forget:${candidate.id}` }
        }
        const result = await this.coordinator.remember({
          text: candidate.content,
          identity,
          scopeName,
          provenance: provenanceFromSessionEvent({
            sessionId: candidate.sourceRefs[0]?.sessionId ?? 'restored-queue',
            turn: candidate.sourceRefs[0]?.turn ?? 0,
            evidence: `queue:${candidate.id}`,
          }),
          dedupeKey: candidate.idempotencyKey,
          semanticKey: candidate.semanticKey,
          ...(candidate.supersedes === undefined ? {} : { supersedes: candidate.supersedes }),
        })
        this.metrics?.increment('extraction.ingested')
        return { status: 'complete', dataRef: `cognee:${operation.dataset}#${result.id}` }
      } catch (error) {
        const code = isMemoryError(error) ? error.code : 'INTERNAL'
        return {
          status: 'failed',
          reason: code,
          retryable: isMemoryError(error) ? error.retryable : true,
        }
      }
    })
    for (const candidate of pending) {
      const operation = await this.outbox.operationFor(candidate.idempotencyKey, 1)
      if (operation === undefined) continue
      if (operation.state === 'complete') {
        await this.queue.recordOutcome(
          candidate,
          candidate.operation === 'forget' ? 'forgotten' : 'ingested',
        )
      } else if (operation.state === 'failed' && operation.retryable === false) {
        await this.queue.recordOutcome(candidate, 'failed', operation.reason ?? 'BACKEND')
        this.metrics?.increment('extraction.failed')
      }
    }
  }

  private rememberPrevious(scopeKey: string, candidates: readonly MemoryCandidate[]): void {
    if (candidates.length === 0) return
    const existing = this.previous.get(scopeKey) ?? []
    this.previous.set(scopeKey, [...existing, ...candidates].slice(-12))
  }

  /**
   * Extract one committed user turn.
   *
   * `llm: 'inline'` (the default, and what tests use) runs the deterministic
   * pass, the LLM pass and ingestion in one await. `llm: 'defer'` runs only the
   * fast deterministic pass inline, then schedules the LLM pass as a tracked
   * background task; the model stream calls `settle()` after the response so a
   * slow local model never delays the first token.
   */
  async handleTurn(
    input: ExtractionTurnInput,
    options: { readonly llm?: 'inline' | 'defer' } = {},
  ): Promise<void> {
    if (!this.config.extraction.enabled) return
    try {
      const identity: CallerIdentity = {
        sessionId: input.sessionId,
        ...(input.agentPreset === undefined ? {} : { agentPreset: input.agentPreset }),
      }
      const resolved = await this.coordinator.resolveIdentity(identity)
      if (resolved.principalId === undefined || resolved.principalId === '') {
        this.lastError = 'no authenticated principal for durable extraction'
        return
      }
      const scopeName = this.config.extraction.scope as Exclude<MemoryScope, 'session' | 'global'>
      const scope = scopeFromName(scopeName, resolved, this.config)
      if (scope === undefined) {
        this.lastError = `no ${scopeName} scope for extraction`
        return
      }
      let deferred = false
      // `autoWrite: false` stops NEW extraction but never loses accepted work:
      // the queue and outbox are still recovered and drained below.
      if (this.config.autoWrite && input.messages.length > 0) {
        const scopeKeyValue = `${scope.scope}:${scope.id}`
        const previous = this.previous.get(scopeKeyValue) ?? []
        const candidates: MemoryCandidate[] = []
        const llmInputs: ExtractionInput[] = []
        for (const message of input.messages) {
          const sourceInput: ExtractionInput = {
            text: message.text,
            identity: resolved,
            scope,
            principalId: resolved.principalId,
            turn: input.turn,
            ...(message.seq === undefined ? {} : { seq: message.seq }),
            previous: [...previous, ...candidates],
          }
          const produced = this.config.extraction.deterministic
            ? extractDeterministicCandidates(sourceInput)
            : []
          if (produced.length === 0 && this.config.extraction.llm.enabled) {
            llmInputs.push(sourceInput)
          }
          for (const candidate of produced) {
            this.metrics?.increment('extraction.candidates')
            const result = await this.queue.enqueue(candidate)
            if (result.accepted) {
              this.metrics?.increment('extraction.queued')
              candidates.push(candidate)
            }
          }
        }
        this.rememberPrevious(scopeKeyValue, candidates)
        this.lastCandidates = candidates.slice(-8)
        if (llmInputs.length > 0) {
          if (options.llm === 'defer') {
            this.stageLlmPass(input.sessionId, llmInputs, resolved, scopeName, scopeKeyValue)
            deferred = true
          } else {
            const produced = await this.llmPass(llmInputs)
            this.rememberPrevious(scopeKeyValue, produced)
            this.lastCandidates = [...candidates, ...produced].slice(-8)
          }
        }
      }
      if (!deferred) await this.drainQueue(resolved, scopeName)
      this.lastError = undefined
    } catch (error) {
      this.metrics?.increment('extraction.failed')
      this.lastError = isMemoryError(error) ? error.code : 'EXTRACTION_FAILED'
    }
  }

  /**
   * Run the LLM pass and queue its candidates (no drain). Returns the accepted
   * candidates so `lastCandidates`/`previous` stay accurate.
   */
  private async llmPass(inputs: readonly ExtractionInput[]): Promise<MemoryCandidate[]> {
    const accepted: MemoryCandidate[] = []
    for (const sourceInput of inputs) {
      this.metrics?.increment('extraction.llm.requests')
      const started = Date.now()
      let produced: MemoryCandidate[] = []
      try {
        produced = await extractWithLlm(sourceInput, {
          enabled: true,
          endpoint: this.config.extraction.llm.endpoint,
          model: this.config.extraction.llm.model,
          apiKeyEnv: this.config.extraction.llm.apiKeyEnv,
          timeoutMs: this.config.extraction.llm.timeoutMs,
          maxCandidates: this.config.extraction.llm.maxCandidates,
          ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
        })
      } catch {
        this.metrics?.increment('extraction.llm.failures')
        continue
      } finally {
        this.metrics?.observe('extraction.llm.latencyMs', Date.now() - started)
      }
      for (const candidate of produced) {
        this.metrics?.increment('extraction.candidates')
        const result = await this.queue.enqueue(candidate)
        if (result.accepted) {
          this.metrics?.increment('extraction.queued')
          accepted.push(candidate)
        }
      }
    }
    return accepted
  }

  /**
   * Stage the LLM pass without starting it. The session hooks call `settle()`
   * only after the assistant response is streamed, so the extractor never
   * competes with the turn's own model request (the live Studio endpoint serves
   * one generation at a time; concurrent scheduling doubled turn latency).
   */
  private stageLlmPass(
    sessionId: string,
    inputs: readonly ExtractionInput[],
    resolved: CallerIdentity,
    scopeName: Exclude<MemoryScope, 'session' | 'global'>,
    scopeKeyValue: string,
  ): void {
    this.metrics?.increment('extraction.llm.deferred')
    this.stagedLlm.set(sessionId, { inputs, resolved, scopeName, scopeKeyValue })
  }

  /**
   * Start a staged pass (idempotent per session). The tracked task covers the
   * LLM request, queue enqueue and Cognee drain, so `settle()` returning true
   * means the candidate is durable *and* ingested. The pass is started only
   * after the response (never concurrently with the turn's own model request),
   * and each profile chooses how long the turn boundary may wait for it.
   */
  private startStagedPass(sessionId: string): void {
    if (this.llmTasks.has(sessionId)) return
    const staged = this.stagedLlm.get(sessionId)
    if (staged === undefined) return
    this.stagedLlm.delete(sessionId)
    const task = Promise.resolve()
      .then(async () => {
        const produced = await this.llmPass(staged.inputs)
        if (produced.length > 0) {
          this.rememberPrevious(staged.scopeKeyValue, produced)
          this.lastCandidates = [...this.lastCandidates, ...produced].slice(-8)
        }
        await this.drainQueue(staged.resolved, staged.scopeName)
      })
      .catch(() => {
        this.metrics?.increment('extraction.llm.failures')
      })
      .finally(() => {
        if (this.llmTasks.get(sessionId) === task) {
          this.llmTasks.delete(sessionId)
          this.settleDeadlines.delete(sessionId)
        }
      })
    this.llmTasks.set(sessionId, task)
  }

  /**
   * Await the session's background LLM pass for at most `timeoutMs`. Called
   * after the assistant response is streamed (and before the turn boundary) so
   * a one-shot headless process still completes ingestion, while a slow model
   * can add no more than the configured `settleMs` to a turn.
   */
  async settle(sessionId: string, timeoutMs?: number): Promise<boolean> {
    this.startStagedPass(sessionId)
    const task = this.llmTasks.get(sessionId)
    if (task === undefined) {
      this.settleDeadlines.delete(sessionId)
      return true
    }
    const now = Date.now()
    const budget = timeoutMs ?? this.config.extraction.llm.settleMs
    // Stream-end and turn-stopping both call settle for the same turn; share one
    // budget so the two hooks cannot each add their own wait.
    const deadline = this.settleDeadlines.get(sessionId) ?? now + budget
    this.settleDeadlines.set(sessionId, deadline)
    const remaining = Math.max(0, deadline - now)
    let timer: ReturnType<typeof setTimeout> | undefined
    const completed = await Promise.race([
      task.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), remaining)
        ;(timer as { unref?: () => void }).unref?.()
      }),
    ])
    if (timer !== undefined) clearTimeout(timer)
    this.metrics?.increment(completed ? 'extraction.llm.settled' : 'extraction.llm.settleTimeouts')
    if (completed) this.settleDeadlines.delete(sessionId)
    return completed
  }

  async status(): Promise<ExtractionSnapshot> {
    return {
      enabled: this.config.extraction.enabled,
      deterministic: this.config.extraction.deterministic,
      llmEnabled: this.config.extraction.llm.enabled,
      autoWrite: this.config.autoWrite,
      scope: this.config.extraction.scope,
      queue: await this.queue.status(),
      outbox: await this.outbox.status(),
      pendingCandidates: (await this.queue.pending()).slice(0, 20).map((candidate) => ({
        id: candidate.id,
        idempotencyKey: candidate.idempotencyKey,
        operation: candidate.operation,
        semanticKey: candidate.semanticKey,
        preview: candidate.content.replace(/\s+/g, ' ').trim().slice(0, 160),
      })),
      lastCandidates: this.lastCandidates,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    }
  }
}
