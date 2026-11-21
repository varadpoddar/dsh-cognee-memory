import { describe, expect, it } from 'vitest'
import { createRecallTool } from '../src/tools/recall.js'
import { SESSION_SCOPE, createHarness, identity, record } from './helpers/fake-coordinator.js'

function exec() {
  return { signal: new AbortController().signal, agent: { session: { id: 'session-1' } } }
}

describe('memory_recall tool', () => {
  it('returns recalled memories and renders them as untrusted data', async () => {
    const harness = createHarness({
      async recall() {
        return [record('1', 'alpha'), record('2', 'beta', SESSION_SCOPE)]
      },
    })
    const tool = createRecallTool({ coordinator: harness.coordinator, config: harness.config })
    const value = (await tool.execute({ query: 'what happened?' }, exec())) as never
    const rendered = tool.output.render({}, value).map((block) => block.text).join('\n')
    expect(rendered).toContain('alpha')
    expect(rendered).toContain('untrusted data')
    expect(rendered).toContain('- [project] alpha')
  })

  it('filters to an explicitly requested caller scope', async () => {
    const harness = createHarness({
      async recall() {
        return [record('1', 'alpha'), record('2', 'beta', SESSION_SCOPE)]
      },
    })
    const tool = createRecallTool({ coordinator: harness.coordinator, config: harness.config })
    const value = (await tool.execute({ query: 'q', scope: 'session' }, exec())) as {
      count: number
      memories: Array<{ id: string }>
    }
    expect(value.count).toBe(1)
    expect(value.memories[0]?.id).toBe('2')
  })

  it('returns an empty, explicit result message', async () => {
    const harness = createHarness()
    const tool = createRecallTool({ coordinator: harness.coordinator, config: harness.config })
    const value = (await tool.execute({ query: 'q' }, exec())) as never
    expect(tool.output.render({}, value)[0]?.text).toBe('No memories recalled.')
  })

  it('validates query and limit arguments', async () => {
    const harness = createHarness()
    const tool = createRecallTool({ coordinator: harness.coordinator, config: harness.config })
    await expect(tool.execute({ query: '' }, exec())).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(tool.execute({ query: 'q', limit: 0 }, exec())).rejects.toMatchObject({
      code: 'VALIDATION',
    })
    expect(harness.calls.recall).toHaveLength(0)
  })

  it('forwards the execution signal', async () => {
    const harness = createHarness()
    const controller = new AbortController()
    const tool = createRecallTool({ coordinator: harness.coordinator, config: harness.config })
    await tool.execute({ query: 'q' }, { signal: controller.signal, agent: { session: { id: 'session-1' } } })
    expect(harness.calls.recall[0]?.signal).toBe(controller.signal)
  })

  it('does not let a caller access a scope it lacks', async () => {
    const harness = createHarness()
    const tool = createRecallTool({ coordinator: harness.coordinator, config: harness.config })
    await expect(
      tool.execute({ query: 'q', scope: 'team' }, { signal: new AbortController().signal, agent: { session: { id: 'session-1' } } }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(harness.calls.recall).toHaveLength(0)
  })
})
