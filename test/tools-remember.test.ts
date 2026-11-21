import { describe, expect, it } from 'vitest'
import { createRememberTool } from '../src/tools/remember.js'
import { MemoryError } from '../src/errors.js'
import { PROJECT_SCOPE, createHarness, identity } from './helpers/fake-coordinator.js'

function exec() {
  return { signal: new AbortController().signal, agent: { session: { id: 'session-1' } } }
}

describe('memory_remember tool', () => {
  it('stores through the coordinator with tool provenance', async () => {
    const harness = createHarness()
    const tool = createRememberTool({ coordinator: harness.coordinator, config: harness.config })
    const value = (await tool.execute(
      { text: 'durable fact', tags: ['ops'] },
      exec(),
    )) as Record<string, unknown>
    expect(value).toMatchObject({ stored: true, id: 'mem-1', scope: PROJECT_SCOPE })
    expect(harness.calls.remember[0]).toMatchObject({
      text: 'durable fact',
      tags: ['ops'],
      provenance: expect.objectContaining({ kind: 'tool_call', source: 'tool:memory_remember' }),
    })
  })

  it('renders a concise result without echoing the memory text', async () => {
    const harness = createHarness()
    const tool = createRememberTool({ coordinator: harness.coordinator, config: harness.config })
    const value = (await tool.execute({ text: 'secret-ish but clean fact' }, exec())) as never
    const rendered = tool.output.render({}, value).map((block) => block.text).join('\n')
    expect(rendered).toContain('Memory stored')
    expect(rendered).toContain('mem-1')
    expect(rendered).not.toContain('secret-ish but clean fact')
  })

  it('rejects invalid arguments before any backend call', async () => {
    const harness = createHarness()
    const tool = createRememberTool({ coordinator: harness.coordinator, config: harness.config })
    await expect(tool.execute({ text: '   ' }, exec())).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(tool.execute({ text: 'ok', extra: true }, exec())).rejects.toMatchObject({
      code: 'VALIDATION',
    })
    expect(harness.calls.remember).toHaveLength(0)
  })

  it('blocks credentials before the adapter is called', async () => {
    const harness = createHarness()
    const tool = createRememberTool({ coordinator: harness.coordinator, config: harness.config })
    await expect(
      tool.execute({ text: `key sk-${'a'.repeat(32)}` }, exec()),
    ).rejects.toMatchObject({ code: 'REDACTION_BLOCKED' })
    expect(harness.calls.remember).toHaveLength(0)
  })

  it('propagates typed coordinator failures', async () => {
    const harness = createHarness({
      async remember() {
        throw new MemoryError('FORBIDDEN', 'denied')
      },
    })
    const tool = createRememberTool({ coordinator: harness.coordinator, config: harness.config })
    await expect(tool.execute({ text: 'fact' }, exec())).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
