import { MemoryError } from '../errors.js'
import type { CogneeMemoryConfig } from '../config/schema.js'
import type { MemoryCoordinator } from '../memory/coordinator.js'
import { provenanceFromTaskOutcome } from '../memory/provenance.js'
import type { Metrics } from '../telemetry/metrics.js'
import type { CallerIdentity, RememberResult } from '../types.js'

export interface AuthoritativeTaskOutcome {
  readonly taskId: string
  readonly status: 'completed' | 'failed' | 'cancelled'
  /** Authoritative task summary supplied by the task owner, never model prose. */
  readonly summary: string
  /** Stable pointer to the durable task record. */
  readonly evidence: string
  readonly scopeName?: 'project' | 'team' | 'global'
  readonly tags?: readonly string[]
}

/**
 * Phase 1 has no verified DSH task lifecycle hook (0.2.1-rc.5 exposes agent and
 * session hooks only). This recorder is the narrow ingestion boundary that a
 * verified task owner must call in Phase 2; it is deliberately not wired to
 * assistant messages, turn-stopping, or any other self-report channel.
 */
export class TaskLifecycleRecorder {
  private readonly coordinator: Pick<MemoryCoordinator, 'remember'>
  private readonly config: CogneeMemoryConfig
  private readonly metrics: Metrics | undefined

  constructor(deps: {
    readonly coordinator: Pick<MemoryCoordinator, 'remember'>
    readonly config: CogneeMemoryConfig
    readonly metrics?: Metrics
  }) {
    this.coordinator = deps.coordinator
    this.config = deps.config
    this.metrics = deps.metrics
  }

  async record(
    outcome: AuthoritativeTaskOutcome,
    identity: CallerIdentity,
  ): Promise<RememberResult | undefined> {
    if (outcome.status !== 'completed') return undefined
    const taskId = outcome.taskId.trim()
    const summary = outcome.summary.trim()
    const evidence = outcome.evidence.trim()
    if (taskId === '' || summary === '' || evidence === '') {
      throw new MemoryError('VALIDATION', 'completed task outcome requires taskId, summary, and evidence')
    }
    const provenance = provenanceFromTaskOutcome(
      { taskId, status: 'completed', evidence },
      identity,
    )
    return this.coordinator.remember({
      text: summary,
      identity,
      scopeName: outcome.scopeName ?? 'project',
      provenance,
      ...(outcome.tags === undefined ? {} : { tags: outcome.tags }),
    })
  }
}
