import { describe, expect, it } from 'vitest'
import {
  createProvenance,
  isAuthoritativeProvenance,
  provenanceFromTaskOutcome,
  provenanceFromTool,
} from '../src/memory/provenance.js'

describe('provenance', () => {
  it('accepts every evidence-backed kind', () => {
    for (const kind of ['user_explicit', 'tool_call', 'task_outcome', 'session_event', 'import'] as const) {
      const provenance = createProvenance({
        kind,
        source: 'test',
        recordedAt: '2026-01-01T00:00:00.000Z',
        ...(kind === 'task_outcome' ? { taskId: 't1', evidence: 'task-store:t1' } : {}),
        ...(kind === 'session_event' ? { sessionId: 's1', turn: 1 } : {}),
      })
      expect(isAuthoritativeProvenance(provenance)).toBe(true)
    }
  })

  it('rejects model self-report and unknown kinds', () => {
    expect(() => createProvenance({ kind: 'model_self_report', source: 'assistant' })).toThrow(/not authoritative/)
    expect(() => createProvenance({ kind: 'guess', source: 'assistant' })).toThrow(/not authoritative/)
    expect(isAuthoritativeProvenance({ kind: 'model_self_report', source: 'x' })).toBe(false)
  })

  it('requires task evidence for task outcomes', () => {
    expect(() =>
      createProvenance({ kind: 'task_outcome', source: 'task:t1', taskId: 't1' }),
    ).toThrow(/evidence/)
    expect(() =>
      createProvenance({ kind: 'task_outcome', source: 'task:t1', evidence: 'task-store:t1' }),
    ).toThrow(/taskId/)
  })

  it('requires session and turn for session events', () => {
    expect(() => createProvenance({ kind: 'session_event', source: 'hook' })).toThrow(/sessionId/)
    expect(() =>
      createProvenance({ kind: 'session_event', source: 'hook', sessionId: 's1' }),
    ).toThrow(/turn/)
  })

  it('derives tool provenance without model output', () => {
    const provenance = provenanceFromTool('memory_remember', { sessionId: 's1', agentId: 'a1' })
    expect(provenance).toMatchObject({ kind: 'tool_call', source: 'tool:memory_remember', sessionId: 's1' })
    expect(provenance.evidence).toBeUndefined()
  })

  it('derives task provenance and rejects cancelled outcomes', () => {
    expect(
      provenanceFromTaskOutcome(
        { taskId: 't1', status: 'completed', evidence: 'task-store:t1' },
        { sessionId: 's1' },
      ),
    ).toMatchObject({ kind: 'task_outcome', taskId: 't1', evidence: 'task-store:t1' })
    expect(() =>
      provenanceFromTaskOutcome(
        { taskId: 't1', status: 'cancelled', evidence: 'task-store:t1' },
        {},
      ),
    ).toThrow(/cancelled/)
  })

  it('rejects empty sources and invalid timestamps', () => {
    expect(() => createProvenance({ kind: 'import', source: ' ' })).toThrow(/source/)
    expect(() =>
      createProvenance({ kind: 'import', source: 'importer', recordedAt: 'not-a-date' }),
    ).toThrow(/ISO/)
  })
})
