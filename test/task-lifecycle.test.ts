import { describe, expect, it } from 'vitest'
import { TaskLifecycleRecorder } from '../src/hooks/task-lifecycle.js'
import { FIXED_NOW, PROJECT_SCOPE, createHarness, identity } from './helpers/fake-coordinator.js'

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
      text: 'Deployed the service to staging.',
      scope: PROJECT_SCOPE,
      provenance: expect.objectContaining({
        kind: 'task_outcome',
        taskId: 'task-42',
        evidence: 'task-store:task-42',
      }),
    })
  })

  it('does not write failed or cancelled outcomes', async () => {
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
})
