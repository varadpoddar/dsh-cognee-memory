import { MemoryError } from '../errors.js'
import type { CallerIdentity, Provenance, ProvenanceKind } from '../types.js'

/** Only evidence-backed kinds may write. Model self-report is not in this union. */
export const AUTHORITATIVE_PROVENANCE_KINDS: readonly ProvenanceKind[] = [
  'user_explicit',
  'tool_call',
  'task_outcome',
  'session_event',
  'import',
]

const KINDS = new Set<string>(AUTHORITATIVE_PROVENANCE_KINDS)

export interface TaskOutcomeEvidence {
  readonly taskId: string
  readonly status: 'completed' | 'failed' | 'cancelled'
  /** Stable pointer to the task record/turn, never model prose. */
  readonly evidence: string
}

function isIsoTimestamp(value: string): boolean {
  return value.length > 0 && !Number.isNaN(Date.parse(value))
}

/** Validate and freeze provenance; rejects model self-report and insufficient evidence. */
export function createProvenance(input: {
  kind: ProvenanceKind | string
  source: string
  recordedAt?: string
  sessionId?: string
  agentId?: string
  taskId?: string
  turn?: number
  step?: number
  evidence?: string
}): Provenance {
  if (!KINDS.has(input.kind)) {
    throw new MemoryError('VALIDATION', 'provenance kind is not authoritative')
  }
  if (typeof input.source !== 'string' || input.source.trim() === '') {
    throw new MemoryError('VALIDATION', 'provenance source must not be empty')
  }
  const recordedAt = input.recordedAt ?? new Date().toISOString()
  if (!isIsoTimestamp(recordedAt)) {
    throw new MemoryError('VALIDATION', 'provenance recordedAt must be an ISO timestamp')
  }
  if (input.kind === 'task_outcome') {
    if (input.taskId === undefined || input.taskId.trim() === '') {
      throw new MemoryError('VALIDATION', 'task_outcome provenance requires taskId')
    }
    if (input.evidence === undefined || input.evidence.trim() === '') {
      throw new MemoryError('VALIDATION', 'task_outcome provenance requires an evidence pointer')
    }
  }
  if (input.kind === 'session_event') {
    if (input.sessionId === undefined || input.sessionId === '') {
      throw new MemoryError('VALIDATION', 'session_event provenance requires sessionId')
    }
    if (input.turn === undefined || !Number.isInteger(input.turn)) {
      throw new MemoryError('VALIDATION', 'session_event provenance requires a turn number')
    }
  }
  return Object.freeze({
    kind: input.kind as ProvenanceKind,
    source: input.source.trim(),
    recordedAt,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.turn === undefined ? {} : { turn: input.turn }),
    ...(input.step === undefined ? {} : { step: input.step }),
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
  })
}

export function isAuthoritativeProvenance(value: unknown): value is Provenance {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<Provenance>
  return (
    typeof candidate.kind === 'string' &&
    KINDS.has(candidate.kind) &&
    typeof candidate.source === 'string' &&
    candidate.source.trim() !== '' &&
    typeof candidate.recordedAt === 'string' &&
    isIsoTimestamp(candidate.recordedAt)
  )
}

export function provenanceFromTool(
  toolName: string,
  identity: CallerIdentity,
  options: { turn?: number; step?: number } = {},
): Provenance {
  return createProvenance({
    kind: 'tool_call',
    source: `tool:${toolName}`,
    sessionId: identity.sessionId,
    agentId: identity.agentId,
    turn: options.turn,
    step: options.step,
  })
}

/** Provenance for a fact stated in a committed direct user message. */
export function provenanceFromSessionEvent(input: {
  readonly sessionId: string
  readonly turn: number
  readonly seq?: number
  readonly evidence: string
}): Provenance {
  return createProvenance({
    kind: 'session_event',
    source: 'hook:session/event',
    sessionId: input.sessionId,
    turn: input.turn,
    evidence: input.evidence,
  })
}

/** The only supported automatic write-back source in Phase 1. */
export function provenanceFromTaskOutcome(
  outcome: TaskOutcomeEvidence,
  identity: CallerIdentity,
): Provenance {
  if (outcome.status === 'cancelled') {
    throw new MemoryError('VALIDATION', 'cancelled task outcomes are not durable memories')
  }
  return createProvenance({
    kind: 'task_outcome',
    source: `task:${outcome.taskId}`,
    taskId: outcome.taskId,
    evidence: outcome.evidence,
    sessionId: identity.sessionId,
    agentId: identity.agentId,
  })
}
