import { describe, expect, it, vi } from 'vitest'
import { parseConfig } from '../src/config/schema.js'
import { registerAgentLifecycle, lastUserText } from '../src/hooks/agent-lifecycle.js'
import { Metrics } from '../src/telemetry/metrics.js'
import type { PromptContextRegistration } from '../src/types.js'
import { createFakePluginContext, type FakePluginContext } from './helpers/fake-context.js'

function agentFixture() {
  const registrations: PromptContextRegistration[] = []
  let disposed = false
  const agent = {
    session: { id: 'session-1' },
    ctx: {
      systemPrompt: {
        context(registration: PromptContextRegistration) {
          registrations.push(registration)
          return () => {
            disposed = true
          }
        },
        section() {
          throw new Error('section must not be used')
        },
      },
    },
  }
  return { agent, registrations, isDisposed: () => disposed }
}

function listenerFor(fake: FakePluginContext, name: string) {
  const entry = fake.listeners.find((candidate) => candidate.name === name)
  if (entry === undefined) throw new Error(`missing listener ${name}`)
  return entry.listener as unknown as (...args: unknown[]) => unknown
}

const config = parseConfig({ scopeDefaults: { projectId: '/workspace/demo' } })
const nextDecision = { kind: 'enter' as const, messages: [] }

function preStep(agent: unknown, messages: unknown[], signal = new AbortController().signal) {
  return { agent, messages, turn: 1, step: 1, signal }
}

describe('lastUserText', () => {
  it('reads the last text block from the last user message', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'user', content: [{ type: 'text', text: 'second' }, { type: 'image', text: '' }] },
    ]
    expect(lastUserText(messages)).toBe('second')
  })

  it('ignores non-text and missing content', () => {
    expect(lastUserText([{ role: 'assistant', content: 'no' }, { content: [{ type: 'image' }] }])).toBe('')
    expect(lastUserText([])).toBe('')
  })

  it('bounds the query length', () => {
    expect(lastUserText([{ content: [{ type: 'text', text: 'q'.repeat(5_000) }] }]).length).toBe(2_000)
  })
})

describe('registerAgentLifecycle', () => {
  it('wires the verified agent + assembly hooks and can remove them', () => {
    const fake = createFakePluginContext()
    const dispose = registerAgentLifecycle(fake.ctx, {
      coordinator: { recallService: { safeRecall: vi.fn() } },
      config,
    })
    expect(fake.listeners.map((entry) => entry.name).sort()).toEqual([
      'agent/created',
      'agent/disposed',
      'agent/inbox/claimed',
      'agent/pre-step',
      'system-prompt/assemble',
    ])
    dispose()
    expect(fake.listeners).toHaveLength(0)
  })

  it('registers prompt context in the agent scope, never at plugin scope', () => {
    const fake = createFakePluginContext()
    const fixture = agentFixture()
    registerAgentLifecycle(fake.ctx, {
      coordinator: { recallService: { safeRecall: vi.fn() } },
      config,
    })
    listenerFor(fake, 'agent/created')({ agent: fixture.agent })
    expect(fixture.registrations).toHaveLength(1)
    expect(fixture.registrations[0]?.name).toBe('cognee:memory')
    expect(fake.contexts).toHaveLength(0)
  })

  it('does not duplicate a prompt context for the same session', () => {
    const fake = createFakePluginContext()
    const fixture = agentFixture()
    registerAgentLifecycle(fake.ctx, {
      coordinator: { recallService: { safeRecall: vi.fn() } },
      config,
    })
    const created = listenerFor(fake, 'agent/created')
    created({ agent: fixture.agent })
    created({ agent: fixture.agent })
    expect(fixture.registrations).toHaveLength(1)
  })

  it('starts a refresh from the last user text and calls next exactly once without awaiting recall', async () => {
    const fake = createFakePluginContext()
    const fixture = agentFixture()
    let resolveRecall: ((value: never[]) => void) | undefined
    const pending = new Promise<never[]>((resolve) => {
      resolveRecall = resolve
    })
    const safeRecall = vi.fn(() => pending)
    const metrics = new Metrics()
    registerAgentLifecycle(fake.ctx, {
      coordinator: { recallService: { safeRecall } },
      config,
      metrics,
    })
    listenerFor(fake, 'agent/created')({ agent: fixture.agent })
    const next = vi.fn(async () => nextDecision)
    const result = await listenerFor(fake, 'agent/pre-step')(
      preStep(fixture.agent, [{ role: 'user', content: [{ type: 'text', text: 'recall this' }] }]),
      next,
    )
    expect(result).toEqual(nextDecision)
    expect(next).toHaveBeenCalledTimes(1)
    expect(safeRecall).toHaveBeenCalledTimes(1)
    resolveRecall?.([])
    await Promise.resolve()
  })

  it('never rejects the step when refresh fails', async () => {
    const fake = createFakePluginContext()
    const fixture = agentFixture()
    const metrics = new Metrics()
    const safeRecall = vi.fn(async () => Promise.reject(new Error('offline')))
    registerAgentLifecycle(fake.ctx, {
      coordinator: { recallService: { safeRecall } },
      config,
      metrics,
    })
    listenerFor(fake, 'agent/created')({ agent: fixture.agent })
    const next = vi.fn(async () => nextDecision)
    await expect(
      listenerFor(fake, 'agent/pre-step')(
        preStep(fixture.agent, [{ role: 'user', content: [{ type: 'text', text: 'query' }] }]),
        next,
      ),
    ).resolves.toEqual(nextDecision)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('still calls next when no prompt binding exists', async () => {
    const fake = createFakePluginContext()
    const fixture = agentFixture()
    const next = vi.fn(async () => nextDecision)
    registerAgentLifecycle(fake.ctx, {
      coordinator: { recallService: { safeRecall: vi.fn() } },
      config,
    })
    await expect(
      listenerFor(fake, 'agent/pre-step')(preStep(fixture.agent, []), next),
    ).resolves.toEqual(nextDecision)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('disposes the prompt context on agent disposal and stops refreshing', async () => {
    const fake = createFakePluginContext()
    const fixture = agentFixture()
    const safeRecall = vi.fn(async () => [])
    registerAgentLifecycle(fake.ctx, {
      coordinator: { recallService: { safeRecall } },
      config,
    })
    listenerFor(fake, 'agent/created')({ agent: fixture.agent })
    listenerFor(fake, 'agent/disposed')({ agent: fixture.agent })
    expect(fixture.isDisposed()).toBe(true)
    await listenerFor(fake, 'agent/pre-step')(
      preStep(fixture.agent, [{ role: 'user', content: [{ type: 'text', text: 'after' }] }]),
      async () => nextDecision,
    )
    expect(safeRecall).not.toHaveBeenCalled()
  })
})
