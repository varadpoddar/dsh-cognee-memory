import { describe, expect, it } from 'vitest'
import {
  TaskLifecycleRecorder,
  registerTaskMemory,
} from '../src/hooks/task-lifecycle.js'
import {
  FIXED_NOW,
  PROJECT_SCOPE,
  createHarness,
  identity,
} from './helpers/fake-coordinator.js'
import { createFakePluginContext, type FakePluginContext } from './helpers/fake-context.js'

function recorder(overrides: Record<string, unknown> = {}) {
  const harness = createHarness({}, overrides)
  return {
    harness,
    recorder: new TaskLifecycleRecorder({
      coordinator: harness.coordinator,
      config: harness.config,
    }),
  }
}

function listenerFor(fake: FakePluginContext, name: string) {
  const entry = fake.listeners.find((candidate) => candidate.name === name)
  if (entry === undefined) throw new Error(`missing listener ${name}`)
  return entry.listener as unknown as (...args: unknown[]) => unknown
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('TaskLifecycleRecorder', () => {
  it('writes a completed task outcome with authoritative provenance', async () => {
    const { harness, recorder: taskRecorder } = recorder()
    const result = await taskRecorder.record(
      {
        taskId: 'task-42',
        status: 'completed',
        summary: 'Deployed the service to staging.',
        evidence: 'task-store:task-42',
      },
      identity(),
    )
    expect(result).toMatchObject({ id: 'mem-1', scope: PROJECT_SCOPE })
    expect(harness.calls.remember[0]).toMatchObject({
      scope: PROJECT_SCOPE,
      provenance: expect.objectContaining({
        kind: 'task_outcome',
        taskId: 'task-42',
        evidence: 'task-store:task-42',
      }),
      tags: expect.arrayContaining(['task', 'completion', 'completed']),
    })
    expect(harness.calls.remember[0]?.text).toMatch(
      /^task task-42 v1: completed — Deployed the service to staging\. \[evidence: task-store:task-42\]$/,
    )
  })

  it('does not write failed or cancelled outcomes through the legacy entry point', async () => {
    const { harness, recorder: taskRecorder } = recorder()
    await expect(
      taskRecorder.record(
        { taskId: 't1', status: 'failed', summary: 'failed', evidence: 'task-store:t1' },
        identity(),
      ),
    ).resolves.toBeUndefined()
    await expect(
      taskRecorder.record(
        { taskId: 't2', status: 'cancelled', summary: 'cancelled', evidence: 'task-store:t2' },
        identity(),
      ),
    ).resolves.toBeUndefined()
    expect(harness.calls.remember).toHaveLength(0)
  })

  it('requires task id, summary, and evidence', async () => {
    const { recorder: taskRecorder } = recorder()
    await expect(
      taskRecorder.record(
        { taskId: '', status: 'completed', summary: 'x', evidence: 'task-store:t1' },
        identity(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(
      taskRecorder.record(
        { taskId: 't1', status: 'completed', summary: '', evidence: 'task-store:t1' },
        identity(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(
      taskRecorder.record(
        { taskId: 't1', status: 'completed', summary: 'x', evidence: '' },
        identity(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('never accepts a self-reported status', async () => {
    const { harness, recorder: taskRecorder } = recorder()
    const result = await taskRecorder.record(
      {
        taskId: 't1',
        status: 'self-reported',
        summary: 'the model says it succeeded',
        evidence: 'assistant/message',
      } as never,
      identity(),
    )
    expect(result).toBeUndefined()
    expect(harness.calls.remember).toHaveLength(0)
  })

  it('uses a fixed clock through the coordinator', async () => {
    const harness = createHarness({}, {})
    const taskRecorder = new TaskLifecycleRecorder({ coordinator: harness.coordinator, config: harness.config })
    const result = await taskRecorder.record(
      { taskId: 't1', status: 'completed', summary: 'done', evidence: 'task-store:t1' },
      identity(),
    )
    expect(result?.createdAt).toBe(FIXED_NOW)
  })

  it('records a verified lifecycle completion without model text', async () => {
    const { harness, recorder: taskRecorder } = recorder()
    await taskRecorder.recordLifecycle({
      taskId: 'subagent:run-1',
      status: 'completed',
      summary: 'provider local run ended with stopReason=completed',
      evidence: 'subagent/end:run-1',
      identity: identity(),
    })
    expect(harness.calls.remember[0]?.text).toContain('subagent:run-1')
    expect(harness.calls.remember[0]?.tags).toEqual(
      expect.arrayContaining(['task', 'completion', 'completed']),
    )
  })

  it('records failed and blocked lifecycle states truthfully, never as completion', async () => {
    const { harness, recorder: taskRecorder } = recorder()
    await taskRecorder.recordLifecycle({
      taskId: 'run-failed',
      status: 'failed',
      summary: 'run ended with stopReason=error',
      evidence: 'subagent/end:run-failed',
      identity: identity(),
    })
    await taskRecorder.recordLifecycle({
      taskId: 'run-blocked',
      status: 'blocked',
      summary: 'run ended with stopReason=max-tokens',
      evidence: 'subagent/end:run-blocked',
      identity: identity(),
    })
    expect(harness.calls.remember.map((call) => call.tags)).toEqual([
      expect.arrayContaining(['blocker', 'failed']),
      expect.arrayContaining(['blocker', 'blocked']),
    ])
    expect(harness.calls.remember[0]?.text).toContain('failed')
    expect(harness.calls.remember[0]?.text).not.toContain('completed')
  })

  it('records an accepted milestone only with a named authority and evidence', async () => {
    const { harness, recorder: taskRecorder } = recorder()
    await expect(
      taskRecorder.acceptMilestone(
        { taskId: 't1', version: 2, milestone: 'M1', acceptedBy: '', evidence: 'review:7' },
        identity(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(
      taskRecorder.acceptMilestone(
        { taskId: 't1', version: 2, milestone: 'M1', acceptedBy: 'reviewer', evidence: '' },
        identity(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
    await taskRecorder.acceptMilestone(
      {
        taskId: 't1',
        version: 2,
        milestone: 'Gate 0 evidence accepted',
        acceptedBy: 'reviewer:alice',
        evidence: 'review:7',
      },
      identity(),
    )
    expect(harness.calls.remember[0]).toMatchObject({
      tags: expect.arrayContaining(['milestone', 'accepted']),
      provenance: expect.objectContaining({ taskId: 't1', evidence: 'review:7' }),
    })
    expect(harness.calls.remember[0]?.text).toContain('milestone accepted')
    expect(harness.calls.remember[0]?.text).toContain('accepted by reviewer:alice')
  })

  it('records an accepted decision with its rationale', async () => {
    const { harness, recorder: taskRecorder } = recorder()
    await taskRecorder.acceptDecision(
      {
        taskId: 't1',
        version: 1,
        decision: 'Keep CHUNKS as the default search type',
        acceptedBy: 'architect',
        rationale: 'fastest and the fixture ranks first',
        evidence: 'docs:COMPATIBILITY#gate-0',
      },
      identity(),
    )
    expect(harness.calls.remember[0]?.text).toContain('decision accepted')
    expect(harness.calls.remember[0]?.text).toContain('rationale: fastest')
    expect(harness.calls.remember[0]?.tags).toEqual(
      expect.arrayContaining(['decision', 'accepted']),
    )
  })

  it('records a reusable finding only with evidence', async () => {
    const { harness, recorder: taskRecorder } = recorder()
    await expect(
      taskRecorder.recordFinding(
        { taskId: 't1', version: 1, finding: 'x', evidence: '  ' },
        identity(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
    await taskRecorder.recordFinding(
      { taskId: 't1', version: 1, finding: 'GRAPH_COMPLETION is slower', evidence: 'bench:1' },
      identity(),
    )
    expect(harness.calls.remember[0]?.tags).toEqual(
      expect.arrayContaining(['finding', 'verified']),
    )
  })

  it('records a confirmed blocker with its real state', async () => {
    const { harness, recorder: taskRecorder } = recorder()
    await taskRecorder.confirmBlocker(
      {
        taskId: 't1',
        version: 1,
        blocker: 'Cognee ingestion timed out',
        status: 'blocked',
        severity: 'high',
        evidence: 'run:42',
      },
      identity(),
    )
    expect(harness.calls.remember[0]?.text).toContain('blocked — Cognee ingestion timed out')
    expect(harness.calls.remember[0]?.tags).toEqual(
      expect.arrayContaining(['blocker', 'blocked']),
    )
  })

  it('validates commit refs and records them as durable evidence', async () => {
    const { harness, recorder: taskRecorder } = recorder()
    await expect(
      taskRecorder.recordCommitRef(
        { taskId: 't1', version: 1, sha: 'not-a-sha', evidence: 'git:1' },
        identity(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(
      taskRecorder.recordCommitRef(
        { taskId: 't1', version: 1, sha: 'abc12', evidence: 'git:1' },
        identity(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
    await taskRecorder.recordCommitRef(
      { taskId: 't1', version: 1, sha: '8448188', repo: 'dsh-cognee-memory', evidence: 'git:8448188' },
      identity(),
    )
    expect(harness.calls.remember[0]?.text).toContain('commit 8448188 in dsh-cognee-memory')
    expect(harness.calls.remember[0]?.tags).toEqual(expect.arrayContaining(['commit', 'verified']))
  })

  it('is idempotent for the same task version and payload', async () => {
    const { harness, recorder: taskRecorder } = recorder()
    await taskRecorder.acceptMilestone(
      { taskId: 't1', version: 1, milestone: 'M1', acceptedBy: 'reviewer', evidence: 'review:1' },
      identity(),
    )
    const replay = await taskRecorder.acceptMilestone(
      { taskId: 't1', version: 1, milestone: 'M1', acceptedBy: 'reviewer', evidence: 'review:1' },
      identity(),
    )
    expect(replay?.deduplicated).toBe(true)
    expect(harness.calls.remember).toHaveLength(1)
  })

  it('treats a version bump as new evidence', async () => {
    const { harness, recorder: taskRecorder } = recorder()
    await taskRecorder.recordFinding(
      { taskId: 't1', version: 1, finding: 'first', evidence: 'run:1' },
      identity(),
    )
    await taskRecorder.recordFinding(
      { taskId: 't1', version: 2, finding: 'second', evidence: 'run:2' },
      identity(),
    )
    expect(harness.calls.remember).toHaveLength(2)
    expect(harness.calls.remember[1]?.text).toContain('v2')
  })

  it('caps records per task', async () => {
    const { harness, recorder: taskRecorder } = recorder({
      taskMemory: { maxRecordsPerTask: 2 },
    })
    for (let index = 0; index < 3; index += 1) {
      await taskRecorder.recordFinding(
        { taskId: 't1', version: index + 1, finding: `finding ${index}`, evidence: `run:${index}` },
        identity(),
      )
    }
    expect(harness.calls.remember).toHaveLength(2)
  })

  it('does nothing when task memory is disabled', async () => {
    const { harness, recorder: taskRecorder } = recorder({ taskMemory: { enabled: false } })
    expect(
      await taskRecorder.recordLifecycle({
        taskId: 'run-1',
        status: 'completed',
        summary: 'done',
        evidence: 'subagent/end:run-1',
        identity: identity(),
      }),
    ).toBeUndefined()
    expect(harness.calls.remember).toHaveLength(0)
  })
})

describe('registerTaskMemory', () => {
  function harness(overrides: Record<string, unknown> = {}) {
    const fake = createFakePluginContext()
    const h = createHarness({}, { identity: { principalId: 'p1' }, ...overrides })
    const recorder = new TaskLifecycleRecorder({
      coordinator: h.coordinator,
      config: h.config,
      metrics: h.metrics,
    })
    const dispose = registerTaskMemory(fake.ctx, {
      recorder,
      coordinator: h.coordinator,
      config: h.config,
      metrics: h.metrics,
    })
    return { fake, h, dispose }
  }

  it('subscribes both verified lifecycle contracts and unwinds cleanly', () => {
    const { fake, dispose } = harness()
    expect(fake.listeners.map((entry) => entry.name)).toEqual([
      'subagent/end',
      'workflow/agent-end',
    ])
    dispose()
    expect(fake.listeners).toHaveLength(0)
  })

  it('records a completed subagent settlement and never its assistant message', async () => {
    const { fake, h } = harness()
    listenerFor(fake, 'subagent/end')({
      runId: 'run-1',
      provider: 'local',
      id: 'child-session',
      local: true,
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'MODEL CLAIM: everything passed' }],
    })
    await flush()
    expect(h.calls.remember).toHaveLength(1)
    expect(h.calls.remember[0]?.text).toContain('stopReason=completed')
    expect(JSON.stringify(h.calls.remember[0])).not.toContain('MODEL CLAIM')
    expect(h.metrics.snapshot().counters['task.recorded']).toBe(1)
  })

  it('records an errored subagent settlement as failed, not completed', async () => {
    const { fake, h } = harness()
    listenerFor(fake, 'subagent/end')({
      runId: 'run-2',
      provider: 'local',
      id: 'child-session',
      local: true,
      stopReason: 'error',
    })
    await flush()
    expect(h.calls.remember[0]?.tags).toEqual(expect.arrayContaining(['blocker', 'failed']))
    expect(h.calls.remember[0]?.text).not.toContain('completed')
  })

  it('records workflow completions and cancellations truthfully', async () => {
    const { fake, h } = harness()
    const end = listenerFor(fake, 'workflow/agent-end')
    end(
      { id: 'wf-1', meta: { name: 'release', description: 'release workflow' } },
      { seq: 1, label: 'build', childId: 'child-a', outcome: 'completed', phase: 'build' },
    )
    end(
      { id: 'wf-1', meta: { name: 'release', description: 'release workflow' } },
      { seq: 2, label: 'ship', childId: 'child-b', outcome: 'cancelled' },
    )
    await flush()
    expect(h.calls.remember).toHaveLength(2)
    expect(h.calls.remember[0]?.tags).toEqual(
      expect.arrayContaining(['workflow', 'completion', 'build']),
    )
    expect(h.calls.remember[1]?.tags).toEqual(expect.arrayContaining(['blocker', 'blocked']))
  })

  it('writes nothing when the deployment has no authenticated principal', async () => {
    const fake = createFakePluginContext()
    const h = createHarness({}, {})
    const recorder = new TaskLifecycleRecorder({
      coordinator: h.coordinator,
      config: h.config,
      metrics: h.metrics,
    })
    registerTaskMemory(fake.ctx, {
      recorder,
      coordinator: h.coordinator,
      config: h.config,
      metrics: h.metrics,
    })
    listenerFor(fake, 'subagent/end')({
      runId: 'run-3',
      provider: 'local',
      id: 'child',
      local: true,
      stopReason: 'completed',
    })
    await flush()
    expect(h.calls.remember).toHaveLength(0)
  })

  it('isolates a coordinator failure from the host loop', async () => {
    const { fake, h } = harness()
    h.coordinator.resolveIdentity = async () => {
      throw new Error('identity probe failed')
    }
    listenerFor(fake, 'subagent/end')({
      runId: 'run-4',
      provider: 'local',
      id: 'child',
      local: true,
      stopReason: 'completed',
    })
    await flush()
    // An identity-probe failure is isolated: no write, no thrown listener.
    expect(h.metrics.snapshot().counters['task.failed']).toBe(0)
    expect(h.calls.remember).toHaveLength(0)
  })
})
