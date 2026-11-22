import { createHash } from 'node:crypto'
import type { CogneeMemoryConfig } from '../config/schema.js'
import { MemoryError } from '../errors.js'
import type { MemoryCoordinator } from '../memory/coordinator.js'
import { provenanceFromTaskOutcome } from '../memory/provenance.js'
import type { Metrics } from '../telemetry/metrics.js'
import type { CallerIdentity, PluginContextLike, RememberResult } from '../types.js'

/**
 * Authoritative task memory (Milestone 4).
 *
 * The only inputs are (a) verified DSH lifecycle settlements — `subagent/end`
 * and `workflow/agent-end`, both emitted exactly once by the host, never by the
 * model — and (b) explicit `accept*`/`confirm*`/`recordCommitRef` calls that
 * carry a named authority and an evidence pointer. Assistant text, tool
 * arguments, and any other self-report channel are never read.
 *
 * Recorded kinds: verified completion, accepted milestone, accepted decision,
 * reusable finding, confirmed blocker (includes real failed/blocked states),
 * and commit refs. Idempotency is `taskId + version + kind + payload digest`,
 * so a retry cannot duplicate a record.
 */
export type TaskRecordKind = 'completion' | 'milestone' | 'decision' | 'finding' | 'blocker' | 'commit'

export type TaskRecordStatus = 'completed' | 'accepted' | 'verified' | 'blocked' | 'failed'

export interface AuthoritativeTaskOutcome {
  readonly taskId: string
  readonly version?: number
  readonly status: 'completed' | 'failed' | 'cancelled'
  /** Authoritative task summary supplied by the task owner, never model prose. */
  readonly summary: string
  /** Stable pointer to the durable task record. */
  readonly evidence: string
  readonly scopeName?: 'project' | 'team' | 'user' | 'agent'
  readonly tags?: readonly string[]
}

interface TaskRecordBase {
  readonly taskId: string
  readonly version: number
  readonly evidence: string
  readonly scopeName?: 'agent' | 'user' | 'project' | 'team'
  readonly tags?: readonly string[]
}

export interface AcceptedMilestone extends TaskRecordBase {
  readonly milestone: string
  readonly acceptedBy: string
  readonly summary?: string
}

export interface AcceptedDecision extends TaskRecordBase {
  readonly decision: string
  readonly acceptedBy: string
  readonly rationale?: string
}

export interface VerifiedFinding extends TaskRecordBase {
  readonly finding: string
  readonly taskSummary?: string
}

export interface ConfirmedBlocker extends TaskRecordBase {
  readonly blocker: string
  readonly status: 'blocked' | 'failed'
  readonly severity?: 'low' | 'medium' | 'high'
}

export interface CommitReference extends TaskRecordBase {
  readonly sha: string
  readonly repo?: string
}

const MAX_TEXT_CHARS = 1_200
const SHA = /^[0-9a-f]{7,40}$/i

function requireText(value: string, field: string): string {
  const trimmed = value.trim()
  if (trimmed === '') throw new MemoryError('VALIDATION', `${field} must not be empty`)
  return trimmed
}

function clip(value: string): string {
  const single = value.replace(/\s*\n+\s*/g, ' ').trim()
  return single.length > MAX_TEXT_CHARS ? `${single.slice(0, MAX_TEXT_CHARS - 1)}…` : single
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

export class TaskLifecycleRecorder {
  private readonly coordinator: Pick<MemoryCoordinator, 'remember'>
  private readonly config: CogneeMemoryConfig
  private readonly metrics: Metrics | undefined
  private readonly perTask = new Map<string, number>()

  constructor(deps: {
    readonly coordinator: Pick<MemoryCoordinator, 'remember'>
    readonly config: CogneeMemoryConfig
    readonly metrics?: Metrics
  }) {
    this.coordinator = deps.coordinator
    this.config = deps.config
    this.metrics = deps.metrics
  }

  private async persist(input: {
    readonly taskId: string
    readonly version: number
    readonly kind: TaskRecordKind
    readonly status: TaskRecordStatus
    readonly text: string
    readonly evidence: string
    readonly identity: CallerIdentity
    readonly scopeName?: string
    readonly tags?: readonly string[]
  }): Promise<RememberResult | undefined> {
    if (!this.config.taskMemory.enabled) return undefined
    const existing = this.perTask.get(input.taskId) ?? 0
    if (existing >= this.config.taskMemory.maxRecordsPerTask) {
      this.metrics?.increment('task.failed')
      return undefined
    }
    const payload = `${input.kind}\u0000${input.status}\u0000${input.text}\u0000${input.evidence}`
    const dedupeKey = `task:${input.taskId}:v${input.version}:${input.kind}:${digest(payload)}`
    const provenance = provenanceFromTaskOutcome(
      {
        taskId: input.taskId,
        status: input.kind === 'blocker' || input.status === 'failed' ? 'failed' : 'completed',
        evidence: input.evidence,
      },
      input.identity,
    )
    const result = await this.coordinator.remember({
      text: clip(input.text),
      identity: input.identity,
      scopeName: input.scopeName ?? this.config.taskMemory.scope,
      provenance,
      dedupeKey,
      tags: ['task', input.kind, input.status, ...(input.tags ?? [])].slice(0, 16),
    })
    if (!result.deduplicated) this.perTask.set(input.taskId, existing + 1)
    this.metrics?.increment('task.recorded')
    return result
  }

  /** Legacy entry point: only a verified `completed` outcome is durable. */
  async record(
    outcome: AuthoritativeTaskOutcome,
    identity: CallerIdentity,
  ): Promise<RememberResult | undefined> {
    if (outcome.status !== 'completed') return undefined
    const taskId = requireText(outcome.taskId, 'taskId')
    const summary = requireText(outcome.summary, 'summary')
    const evidence = requireText(outcome.evidence, 'evidence')
    return this.persist({
      taskId,
      version: outcome.version ?? 1,
      kind: 'completion',
      status: 'completed',
      text: `task ${taskId} v${outcome.version ?? 1}: completed — ${summary} [evidence: ${evidence}]`,
      evidence,
      identity,
      ...(outcome.scopeName === undefined ? {} : { scopeName: outcome.scopeName }),
      ...(outcome.tags === undefined ? {} : { tags: outcome.tags }),
    })
  }

  /** Verified lifecycle settlement supplied by the host, never by the model. */
  async recordLifecycle(input: {
    readonly taskId: string
    readonly version?: number
    readonly status: 'completed' | 'failed' | 'blocked'
    readonly summary: string
    readonly evidence: string
    readonly identity: CallerIdentity
    readonly tags?: readonly string[]
  }): Promise<RememberResult | undefined> {
    const taskId = requireText(input.taskId, 'taskId')
    const summary = requireText(input.summary, 'summary')
    const evidence = requireText(input.evidence, 'evidence')
    const version = input.version ?? 1
    const completed = input.status === 'completed'
    return this.persist({
      taskId,
      version,
      kind: completed ? 'completion' : 'blocker',
      status: completed ? 'completed' : input.status,
      text: completed
        ? `task ${taskId} v${version}: completed — ${summary} [evidence: ${evidence}]`
        : `task ${taskId} v${version}: ${input.status} — ${summary} [evidence: ${evidence}]`,
      evidence,
      identity: input.identity,
      ...(input.tags === undefined ? {} : { tags: input.tags }),
    })
  }

  async acceptMilestone(input: AcceptedMilestone, identity: CallerIdentity): Promise<RememberResult | undefined> {
    const taskId = requireText(input.taskId, 'taskId')
    const milestone = requireText(input.milestone, 'milestone')
    const acceptedBy = requireText(input.acceptedBy, 'acceptedBy')
    const evidence = requireText(input.evidence, 'evidence')
    const version = input.version
    return this.persist({
      taskId,
      version,
      kind: 'milestone',
      status: 'accepted',
      text: `task ${taskId} v${version}: milestone accepted — ${milestone} (accepted by ${acceptedBy}) [evidence: ${evidence}]${input.summary === undefined ? '' : ` summary: ${input.summary}`}`,
      evidence,
      identity,
      ...(input.scopeName === undefined ? {} : { scopeName: input.scopeName }),
      ...(input.tags === undefined ? {} : { tags: input.tags }),
    })
  }

  async acceptDecision(input: AcceptedDecision, identity: CallerIdentity): Promise<RememberResult | undefined> {
    const taskId = requireText(input.taskId, 'taskId')
    const decision = requireText(input.decision, 'decision')
    const acceptedBy = requireText(input.acceptedBy, 'acceptedBy')
    const evidence = requireText(input.evidence, 'evidence')
    const version = input.version
    return this.persist({
      taskId,
      version,
      kind: 'decision',
      status: 'accepted',
      text: `task ${taskId} v${version}: decision accepted — ${decision} (accepted by ${acceptedBy})${input.rationale === undefined ? '' : `; rationale: ${input.rationale}`} [evidence: ${evidence}]`,
      evidence,
      identity,
      ...(input.scopeName === undefined ? {} : { scopeName: input.scopeName }),
      ...(input.tags === undefined ? {} : { tags: input.tags }),
    })
  }

  async recordFinding(input: VerifiedFinding, identity: CallerIdentity): Promise<RememberResult | undefined> {
    const taskId = requireText(input.taskId, 'taskId')
    const finding = requireText(input.finding, 'finding')
    const evidence = requireText(input.evidence, 'evidence')
    const version = input.version
    return this.persist({
      taskId,
      version,
      kind: 'finding',
      status: 'verified',
      text: `task ${taskId} v${version}: finding — ${finding} [evidence: ${evidence}]${input.taskSummary === undefined ? '' : ` (task: ${input.taskSummary})`}`,
      evidence,
      identity,
      ...(input.scopeName === undefined ? {} : { scopeName: input.scopeName }),
      ...(input.tags === undefined ? {} : { tags: input.tags }),
    })
  }

  async confirmBlocker(input: ConfirmedBlocker, identity: CallerIdentity): Promise<RememberResult | undefined> {
    const taskId = requireText(input.taskId, 'taskId')
    const blocker = requireText(input.blocker, 'blocker')
    const evidence = requireText(input.evidence, 'evidence')
    const version = input.version
    return this.persist({
      taskId,
      version,
      kind: 'blocker',
      status: input.status,
      text: `task ${taskId} v${version}: ${input.status} — ${blocker}${input.severity === undefined ? '' : ` (severity: ${input.severity})`} [evidence: ${evidence}]`,
      evidence,
      identity,
      ...(input.scopeName === undefined ? {} : { scopeName: input.scopeName }),
      ...(input.tags === undefined ? {} : { tags: input.tags }),
    })
  }

  async recordCommitRef(input: CommitReference, identity: CallerIdentity): Promise<RememberResult | undefined> {
    const taskId = requireText(input.taskId, 'taskId')
    const evidence = requireText(input.evidence, 'evidence')
    const sha = input.sha.trim()
    if (!SHA.test(sha)) throw new MemoryError('VALIDATION', 'commit sha must be 7-40 hex characters')
    const version = input.version
    return this.persist({
      taskId,
      version,
      kind: 'commit',
      status: 'verified',
      text: `task ${taskId} v${version}: commit ${sha}${input.repo === undefined ? '' : ` in ${input.repo}`} [evidence: ${evidence}]`,
      evidence,
      identity,
      ...(input.scopeName === undefined ? {} : { scopeName: input.scopeName }),
      ...(input.tags === undefined ? {} : { tags: input.tags }),
    })
  }
}

interface SubagentEndInfo {
  readonly runId: string
  readonly provider: string
  readonly id: string
  readonly stopReason: string
}

interface WorkflowAgentEndInfo {
  readonly id: string
  readonly meta: { readonly name: string }
}

interface WorkflowAgentInfo {
  readonly seq: number
  readonly label: string
  readonly phase?: string
  readonly childId: string
  readonly outcome: 'completed' | 'failed' | 'cancelled'
}

/**
 * Subscribe the recorder to the two verified task lifecycle contracts.
 *
 * Neither payload carries model prose: `subagent/end` exposes a terminal
 * stopReason and run identity; `workflow/agent-end` exposes a terminal outcome
 * and call identity. `lastAssistantMessage` is deliberately never read.
 */
export function registerTaskMemory(
  ctx: PluginContextLike,
  deps: {
    readonly recorder: TaskLifecycleRecorder
    readonly coordinator: Pick<MemoryCoordinator, 'resolveIdentity'>
    readonly config: CogneeMemoryConfig
    readonly metrics?: Metrics
  },
): () => void {
  const disposers: Array<() => unknown> = []
  let disposed = false

  const taskIdentity = async (childId: string | undefined): Promise<CallerIdentity | undefined> => {
    try {
      const resolved = await deps.coordinator.resolveIdentity(
        childId === undefined ? {} : { sessionId: childId },
      )
      if (resolved.principalId === undefined || resolved.principalId === '') return undefined
      return resolved
    } catch {
      return undefined
    }
  }

  const onSubagentEnd = (info: SubagentEndInfo): undefined => {
    if (!deps.config.taskMemory.enabled) return undefined
    void (async () => {
      try {
        const identity = await taskIdentity(info.id)
        if (identity === undefined) return
        const completed = info.stopReason === 'completed'
        await deps.recorder.recordLifecycle({
          taskId: `subagent:${info.runId}`,
          version: 1,
          status: completed ? 'completed' : info.stopReason === 'error' ? 'failed' : 'blocked',
          summary: `provider ${info.provider} run ended with stopReason=${info.stopReason} (child ${info.id})`,
          evidence: `subagent/end:${info.runId}`,
          identity,
          tags: ['subagent', info.provider],
        })
      } catch {
        deps.metrics?.increment('task.failed')
      }
    })()
    return undefined
  }

  const onWorkflowAgentEnd = (info: WorkflowAgentEndInfo, agent: WorkflowAgentInfo): undefined => {
    if (!deps.config.taskMemory.enabled) return undefined
    void (async () => {
      try {
        const identity = await taskIdentity(agent.childId)
        if (identity === undefined) return
        const completed = agent.outcome === 'completed'
        await deps.recorder.recordLifecycle({
          taskId: `workflow:${info.id}:${agent.seq}`,
          version: 1,
          status: completed ? 'completed' : agent.outcome === 'failed' ? 'failed' : 'blocked',
          summary: `workflow ${info.meta.name} call ${agent.seq} (${agent.label}) ended ${agent.outcome}`,
          evidence: `workflow/agent-end:${info.id}:${agent.seq}`,
          identity,
          tags: ['workflow', ...(agent.phase === undefined ? [] : [agent.phase])],
        })
      } catch {
        deps.metrics?.increment('task.failed')
      }
    })()
    return undefined
  }

  disposers.push(ctx.on('subagent/end', onSubagentEnd as never))
  disposers.push(ctx.on('workflow/agent-end', onWorkflowAgentEnd as never))

  return () => {
    if (disposed) return
    disposed = true
    for (const disposer of disposers.splice(0).reverse()) {
      try {
        disposer()
      } catch {
        // Continue unwinding the remaining listeners.
      }
    }
  }
}
