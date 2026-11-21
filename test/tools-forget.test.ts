import { describe, expect, it } from 'vitest'
import { createForgetTool } from '../src/tools/forget.js'
import { UnsupportedOperationError } from '../src/errors.js'
import { PROJECT_SCOPE, createHarness, identity } from './helpers/fake-coordinator.js'

function exec() {
  return { signal: new AbortController().signal, agent: { session: { id: 'session-1' } } }
}

describe('memory_forget tool', () => {
  it('forgets one memory in the default project scope', async () => {
    const harness = createHarness()
    const tool = createForgetTool({ coordinator: harness.coordinator, config: harness.config })
    const value = (await tool.execute({ id: 'mem-1' }, exec())) as Record<string, unknown>
    expect(value).toMatchObject({ forgotten: true, id: 'mem-1', scope: PROJECT_SCOPE })
    expect(harness.calls.forget[0]).toMatchObject({ id: 'mem-1', scope: PROJECT_SCOPE })
    expect(tool.output.render({}, value as never)[0]?.text).toContain('forgotten')
  })

  it('surfaces unsupported per-memory deletion without fallback', async () => {
    const harness = createHarness({
      async forget() {
        throw new UnsupportedOperationError('forget')
      },
    })
    const tool = createForgetTool({ coordinator: harness.coordinator, config: harness.config })
    await expect(tool.execute({ id: 'mem-1' }, exec())).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      operation: 'forget',
    })
    expect(harness.calls.forget).toHaveLength(1)
  })

  it('validates the memory id', async () => {
    const harness = createHarness()
    const tool = createForgetTool({ coordinator: harness.coordinator, config: harness.config })
    await expect(tool.execute({ id: '' }, exec())).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(harness.calls.forget).toHaveLength(0)
  })

  it('rejects a scope the caller does not own', async () => {
    const harness = createHarness()
    const tool = createForgetTool({ coordinator: harness.coordinator, config: harness.config })
    await expect(
      tool.execute({ id: 'mem-1', scope: 'team' }, { signal: new AbortController().signal, agent: { session: { id: 'session-1' } } }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('reports an unconfirmed deletion honestly', async () => {
    const harness = createHarness({
      async forget() {
        return { id: 'mem-1', scope: PROJECT_SCOPE, forgotten: false }
      },
    })
    const tool = createForgetTool({ coordinator: harness.coordinator, config: harness.config })
    const value = (await tool.execute({ id: 'mem-1' }, exec())) as never
    expect(tool.output.render({}, value)[0]?.text).toContain('did not confirm')
  })
})
