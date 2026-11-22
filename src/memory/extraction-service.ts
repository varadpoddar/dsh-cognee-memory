import os from 'node:os'
import path from 'node:path'
import type { CogneeMemoryConfig } from '../config/schema.js'
import { isMemoryError } from '../errors.js'
import { provenanceFromSessionEvent } from './provenance.js'
import type { Metrics } from '../telemetry/metrics.js'
import type { CallerIdentity, MemoryScope } from '../types.js'
import { CandidateQueue, type CandidateQueueStatus } from './candidate-queue.js'
import {
  extractDeterministicCandidates,
  extractWithLlm,
  type MemoryCandidate,
} from './extraction.js'
import type { MemoryCoordinator } from './coordinator.js'
import { scopeFromName } from './scopes.js'

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
  readonly scope: string
  readonly queue: CandidateQueueStatus
  readonly lastCandidates: readonly MemoryCandidate[]
  readonly lastError?: string
}

export interface ExtractionServiceOptions {
  readonly coordinator: Pick<MemoryCoordinator, 'resolveIdentity' | 'remember' | 'forgetByText'>
  readonly config: CogneeMemoryConfig
  readonly metrics?: Metrics
  readonly env?: NodeJS.ProcessEnv
  readonly queue?: CandidateQueue
  readonly fetchImpl?: typeof fetch
}

function queueDir(config: CogneeMemoryConfig, env: NodeJS.ProcessEnv): string {
  if (config.extraction.queue.dir !== undefined) return config.extraction.queue.dir
  const home = env.DSH_HOME?.trim()
  return path.join(home === undefined || home === '' ? path.join(os.homedir(), '.dsh') : home, 'cognee-memory')
}

/**
 * Turns committed user turns into durable candidates, spools them, and drains
 * the spool into the coordinator. It runs even when the agent has no tools:
 * registration does not depend on `tools.enabled`.
 */
export class ExtractionService {
  private readonly coordinator: ExtractionServiceOptions['coordinator']
  private readonly config: CogneeMemoryConfig
  private readonly metrics: Metrics | undefined
  private readonly queue: CandidateQueue
  private readonly fetchImpl: typeof fetch | undefined
  private lastCandidates: readonly MemoryCandidate[] = []
  private lastError: string | undefined
  private readonly previous = new Map<string, MemoryCandidate[]>()

  constructor(options: ExtractionServiceOptions) {
    this.coordinator = options.coordinator
    this.config = options.config
    this.metrics = options.metrics
    this.queue =
      options.queue ??
      new CandidateQueue({
        dir: queueDir(options.config, options.env ?? process.env),
        maxPending: options.config.extraction.queue.maxPending,
      })
    this.fetchImpl = options.fetchImpl
  }

  get queueFile(): string {
    return this.queue.filePath
  }

  /** Retry anything a previous process left queued. Safe to call once at plugin load. */
  async start(): Promise<void> {
    if (!this.config.extraction.enabled) return
    await this.drainQueue()
  }

  private async drainQueue(): Promise<void> {
    const identity = await this.coordinator.resolveIdentity({})
    if (identity.principalId === undefined || identity.principalId === '') return
    const scopeName = this.config.extraction.scope as Exclude<MemoryScope, 'session' | 'global'>
    await this.queue.drain(async (candidate) => {
      if (candidate.operation === 'forget') {
        await this.coordinator.forgetByText({
          text: candidate.content,
          identity,
          scopeName,
        })
        this.metrics?.increment('extraction.ingested')
        return { status: 'forgotten' as const }
      }
      await this.coordinator.remember({
        text: candidate.content,
        identity,
        scopeName,
        provenance: provenanceFromSessionEvent({
          sessionId: candidate.sourceRefs[0]?.sessionId ?? 'restored-queue',
          turn: candidate.sourceRefs[0]?.turn ?? 0,
          evidence: `queue:${candidate.id}`,
        }),
        dedupeKey: candidate.idempotencyKey,
      })
      this.metrics?.increment('extraction.ingested')
      return { status: 'ingested' as const }
    })
  }

  private rememberPrevious(scopeKey: string, candidates: readonly MemoryCandidate[]): void {
    if (candidates.length === 0) return
    const existing = this.previous.get(scopeKey) ?? []
    this.previous.set(scopeKey, [...existing, ...candidates].slice(-12))
  }

  async handleTurn(input: ExtractionTurnInput): Promise<void> {
    if (!this.config.extraction.enabled) return
    if (input.messages.length === 0) return
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
      const scopeKeyValue = `${scope.scope}:${scope.id}`
      const previous = this.previous.get(scopeKeyValue) ?? []
      const candidates: MemoryCandidate[] = []
      for (const message of input.messages) {
        const sourceInput = {
          text: message.text,
          identity: resolved,
          scope,
          principalId: resolved.principalId,
          turn: input.turn,
          ...(message.seq === undefined ? {} : { seq: message.seq }),
          previous: [...previous, ...candidates],
        }
        let produced = this.config.extraction.deterministic
          ? extractDeterministicCandidates(sourceInput)
          : []
        if (produced.length === 0 && this.config.extraction.llm.enabled) {
          this.metrics?.increment('extraction.llm.requests')
          produced = await extractWithLlm(sourceInput, {
            enabled: true,
            endpoint: this.config.extraction.llm.endpoint,
            model: this.config.extraction.llm.model,
            timeoutMs: this.config.extraction.llm.timeoutMs,
            maxCandidates: this.config.extraction.llm.maxCandidates,
            ...(this.fetchImpl === undefined ? {} : { fetchImpl: this.fetchImpl }),
          }).catch(() => {
            this.metrics?.increment('extraction.llm.failures')
            return [] as MemoryCandidate[]
          })
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

      await this.queue.drain(async (candidate) => {
        if (candidate.operation === 'forget') {
          await this.coordinator.forgetByText({
            text: candidate.content,
            identity: resolved,
            scopeName,
          })
          this.metrics?.increment('extraction.ingested')
          return { status: 'forgotten' as const }
        }
        await this.coordinator.remember({
          text: candidate.content,
          identity: resolved,
          scopeName,
          provenance: provenanceFromSessionEvent({
            sessionId: input.sessionId,
            turn: input.turn,
            evidence: `session:${input.sessionId}#turn/${input.turn}/user/message`,
          }),
          dedupeKey: candidate.idempotencyKey,
        })
        this.metrics?.increment('extraction.ingested')
        return { status: 'ingested' as const }
      })
      this.lastError = undefined
    } catch (error) {
      this.metrics?.increment('extraction.failed')
      this.lastError = isMemoryError(error) ? error.code : 'EXTRACTION_FAILED'
    }
  }

  async status(): Promise<ExtractionSnapshot> {
    return {
      enabled: this.config.extraction.enabled,
      deterministic: this.config.extraction.deterministic,
      llmEnabled: this.config.extraction.llm.enabled,
      scope: this.config.extraction.scope,
      queue: await this.queue.status(),
      lastCandidates: this.lastCandidates,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    }
  }
}
