import { describe, expect, it, vi } from 'vitest'
import { parseConfig } from '../src/config/schema.js'
import { registerAgentLifecycle } from '../src/hooks/agent-lifecycle.js'
import {
  MemoryPromptContext,
  applyMemoryContext,
  buildMemoryContextBlock,
  estimateTokens,
} from '../src/hooks/prompt-context.js'
import { identityFromAgent } from '../src/memory/scopes.js'
import { Metrics } from '../src/telemetry/metrics.js'
import type { PromptContextRegistration } from '../src/types.js'
import { createFakePluginContext, type FakePluginContext } from './helpers/fake-context.js'
import { PROJECT_SCOPE, record } from './helpers/fake-coordinator.js'

const FIXTURE = 'The release codename is amber-otter-7731 and the deployment target is CT 103.'
const QUESTION = 'What is the release codename and the deployment target?'

function config(overrides: Record<string, unknown> = {}) {
  return parseConfig({
    enabled: true,
    scopeDefaults: { projectId: '/workspace/demo' },
    ...overrides,
  })
}

function agentFixture(sessionId = 'session-1') {
  const registrations: PromptContextRegistration[] = []
  let disposed = false
  const agent = {
    session: { id: sessionId },
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

function userMessage(text: string) {
  return { id: `msg-${text.length}`, role: 'user', content: [{ type: 'text', text }] }
}

function controllerWith(recall: { safeRecall: ReturnType<typeof vi.fn> }, overrides: Record<string, unknown> = {}) {
  const cfg = config(overrides)
  return new MemoryPromptContext({
    recall: recall as unknown as Pick<import('../src/memory/recall.js').RecallService, 'safeRecall'>,
    config: cfg,
    identity: identityFromAgent({ session: { id: 'session-1' } }),
  })
}

describe('prefetch budgets', () => {
  it('caps the injected block at 8 items by default', () => {
    const cfg = config()
    const hits = Array.from({ length: 12 }, (_, index) => record(String(index), `memory ${index}`))
    const block = buildMemoryContextBlock(hits, cfg, cfg.prefetch)
    expect(block.split('\n').filter((line) => line.startsWith('- ['))).toHaveLength(8)
    expect(block).toContain('- [project · high] memory 7')
    expect(block).not.toContain('memory 8')
    expect(block).toContain('Known context (recalled memory; may be incomplete):')
    expect(block).not.toContain('untrusted')
  })

  it('caps the injected block at 300 tokens by default', () => {
    const cfg = config()
    const hits = Array.from({ length: 12 }, (_, index) =>
      record(String(index), `memory ${index} ${'x'.repeat(400)}`),
    )
    const block = buildMemoryContextBlock(hits, cfg, cfg.prefetch)
    expect(estimateTokens(block)).toBeLessThanOrEqual(300)
    expect(block).not.toBe('')
  })

  it('defaults every budget value to the stable contract', () => {
    const cfg = config()
    expect(cfg.prefetch).toEqual({
      enabled: true,
      maxTokens: 300,
      maxItems: 8,
      maxQueryChars: 900,
      timeoutMs: 1_500,
      maxRetries: 1,
    })
  })

  it('bounds the query-layer search to 900 characters after the stable layer', async () => {
    const recall = { safeRecall: vi.fn(async () => []) }
    const controller = controllerWith(recall)
    controller.beginPrefetch({ turn: 1, query: 'q'.repeat(5_000) })
    await controller.resolveForAssembly({})
    expect(recall.safeRecall).toHaveBeenCalledTimes(2)
    const calls = recall.safeRecall.mock.calls as unknown[][]
    const queryCall = calls.find(
      (call) => (call[0] as { text?: string }).text === 'q'.repeat(900),
    )
    expect(queryCall?.[0]).toMatchObject({ text: 'q'.repeat(900), limit: 16 })
  })
})

describe('applyMemoryContext', () => {
  it('replaces the registered entry in place and keeps neighbours', () => {
    const assembly = {
      contexts: [
        { name: 'other', text: 'keep me' },
        { name: 'cognee:memory', text: '', interpolate: false, required: false },
      ],
    }
    const out = applyMemoryContext(assembly, '<cognee-memory>block</cognee-memory>')
    expect(out.contexts[0]).toEqual({ name: 'other', text: 'keep me' })
    expect(out.contexts[1]).toMatchObject({ name: 'cognee:memory', text: '<cognee-memory>block</cognee-memory>', interpolate: false })
  })

  it('appends the entry only when no registration exists', () => {
    const out = applyMemoryContext({ contexts: [{ name: 'other', text: 'x' }] }, 'block')
    expect(out.contexts).toHaveLength(2)
    expect(out.contexts[1]).toMatchObject({ name: 'cognee:memory', text: 'block' })
    expect(applyMemoryContext({ contexts: [] }, '')).toEqual({ contexts: [] })
  })
})

describe('MemoryPromptContext prefetch', () => {
  it('resolves the block that the first assembly carries, without a second step', async () => {
    const recall = { safeRecall: vi.fn(async () => [record('1', FIXTURE)]) }
    const controller = controllerWith(recall)
    controller.beginPrefetch({ turn: 1, query: QUESTION })
    expect(controller.render()).toBe('')
    const block = await controller.resolveForAssembly({})
    expect(block).toContain('amber-otter-7731')
    expect(block).toContain('CT 103')
    expect(controller.render()).toBe(block)
    // Milestone 6: one stable principal/project search plus one query search.
    expect(recall.safeRecall).toHaveBeenCalledTimes(2)
  })

  it('deduplicates repeated claims for the same turn and query', async () => {
    const recall = { safeRecall: vi.fn(async () => [record('1', FIXTURE)]) }
    const controller = controllerWith(recall)
    controller.beginPrefetch({ turn: 1, query: QUESTION })
    controller.beginPrefetch({ turn: 1, query: QUESTION })
    controller.beginPrefetch({ turn: 1, query: QUESTION })
    await controller.resolveForAssembly({})
    expect(recall.safeRecall).toHaveBeenCalledTimes(2)
  })

  it('invalidates the query layer when the turn changes and keeps the stable cache', async () => {
    const recall = {
      safeRecall: vi.fn(async (input: { text?: string }) => {
        if (input.text === QUESTION) return [record('1', FIXTURE)]
        if (input.text === 'second question') return [record('2', 'second turn memory')]
        return []
      }),
    }
    const controller = controllerWith(recall)
    controller.beginPrefetch({ turn: 1, query: QUESTION })
    expect(await controller.resolveForAssembly({})).toContain('amber-otter')
    controller.noteTurn(2)
    expect(controller.render()).toBe('')
    controller.beginPrefetch({ turn: 2, query: 'second question' })
    expect(await controller.resolveForAssembly({})).toContain('second turn memory')
    // A new turn invalidates the cached block, including the stable layer.
    expect(recall.safeRecall).toHaveBeenCalledTimes(4)
  })

  it('returns empty at the hard deadline instead of stalling the turn', async () => {
    const recall = { safeRecall: vi.fn(() => new Promise<never>(() => undefined)) }
    const metrics = new Metrics()
    const controller = new MemoryPromptContext({
      recall: recall as never,
      config: config({ retrieval: { budgetMs: 50 } }),
      identity: identityFromAgent({ session: { id: 'session-1' } }),
      metrics,
    })
    controller.beginPrefetch({ turn: 1, query: QUESTION })
    const started = Date.now()
    expect(await controller.resolveForAssembly({})).toBe('')
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(metrics.snapshot().counters['prefetch.timeout']).toBe(1)
    expect(controller.render()).toBe('')
  })

  it('skips the wait when the budget was already consumed before assembly', async () => {
    let clock = 1_000
    const recall = { safeRecall: vi.fn(() => new Promise<never>(() => undefined)) }
    const metrics = new Metrics()
    const controller = new MemoryPromptContext({
      recall: recall as never,
      config: config(),
      identity: identityFromAgent({ session: { id: 'session-1' } }),
      metrics,
      now: () => clock,
    })
    controller.beginPrefetch({ turn: 1, query: QUESTION })
    clock += 2_000
    expect(await controller.resolveForAssembly({})).toBe('')
    expect(metrics.snapshot().counters['prefetch.timeout']).toBe(1)
  })

  it('retries once, then degrades to empty', async () => {
    const metrics = new Metrics()
    const recall = {
      safeRecall: vi.fn().mockRejectedValue(new Error('cognee down')),
    }
    const controller = new MemoryPromptContext({
      recall: recall as never,
      config: config(),
      identity: identityFromAgent({ session: { id: 'session-1' } }),
      metrics,
    })
    controller.beginPrefetch({ turn: 1, query: QUESTION })
    expect(await controller.resolveForAssembly({})).toBe('')
    // Two layers per attempt, one bounded retry: 2 x 2 failed searches.
    expect(recall.safeRecall).toHaveBeenCalledTimes(4)
    expect(metrics.snapshot().counters['retry.attempts']).toBe(1)
    expect(metrics.snapshot().counters['prefetch.failures']).toBe(2)
  })

  it('does not retry when the retry budget is zero', async () => {
    const recall = { safeRecall: vi.fn().mockRejectedValue(new Error('cognee down')) }
    const controller = controllerWith(recall, { prefetch: { maxRetries: 0 } })
    controller.beginPrefetch({ turn: 1, query: QUESTION })
    expect(await controller.resolveForAssembly({})).toBe('')
    expect(recall.safeRecall).toHaveBeenCalledTimes(2)
  })

  it('degrades to empty when recall returns no hits', async () => {
    const recall = { safeRecall: vi.fn(async () => []) }
    const controller = controllerWith(recall)
    controller.beginPrefetch({ turn: 1, query: QUESTION })
    expect(await controller.resolveForAssembly({})).toBe('')
    expect(controller.render()).toBe('')
  })

  it('returns nothing when the assembly signal is already aborted', async () => {
    const recall = { safeRecall: vi.fn(async () => [record('1', FIXTURE)]) }
    const controller = controllerWith(recall)
    controller.beginPrefetch({ turn: 1, query: QUESTION })
    const abort = new AbortController()
    abort.abort()
    expect(await controller.resolveForAssembly({ signal: abort.signal })).toBe('')
  })

  it('does not start a prefetch while disabled', async () => {
    const recall = { safeRecall: vi.fn(async () => [record('1', FIXTURE)]) }
    const controller = controllerWith(recall, { prefetch: { enabled: false } })
    controller.beginPrefetch({ turn: 1, query: QUESTION })
    expect(await controller.resolveForAssembly({})).toBe('')
    expect(recall.safeRecall).not.toHaveBeenCalled()
  })

  it('reuses the cached block for later steps without another call', async () => {
    const recall = { safeRecall: vi.fn(async () => [record('1', FIXTURE)]) }
    const controller = controllerWith(recall)
    controller.beginPrefetch({ turn: 1, query: QUESTION })
    const first = await controller.resolveForAssembly({})
    const second = await controller.resolveForAssembly({})
    expect(second).toBe(first)
    expect(recall.safeRecall).toHaveBeenCalledTimes(2)
  })
})

describe('first-turn assembly injection (mock)', () => {
  function harness(recallResult: unknown = [record('1', FIXTURE)]) {
    const fake = createFakePluginContext()
    const metrics = new Metrics()
    const recall = { safeRecall: vi.fn(async () => recallResult) }
    registerAgentLifecycle(fake.ctx, {
      coordinator: { recallService: recall as never },
      config: config(),
      metrics,
    })
    return { fake, metrics, recall }
  }

  function assemble(
    fake: FakePluginContext,
    agent: unknown,
    registered: PromptContextRegistration | undefined,
    signal?: AbortSignal,
  ) {
    const listener = listenerFor(fake, 'system-prompt/assemble')
    const registeredText =
      registered === undefined
        ? undefined
        : typeof registered.text === 'function'
          ? registered.text(undefined)
          : registered.text
    const contexts =
      registeredText === undefined
        ? [{ name: 'persona', text: 'you are dsh' }]
        : [
            { name: 'persona', text: 'you are dsh' },
            { name: 'cognee:memory', text: registeredText, interpolate: false },
          ]
    return listener({ sections: [], contexts, tools: [], variables: {} }, { agent, signal }, async () => ({
      sections: [],
      contexts,
      tools: [],
      variables: {},
    })) as Promise<{ contexts: Array<{ name: string; text: string }> }>
  }

  it('puts turn-1 memory into the very first assembly (claim preceded it)', async () => {
    const { fake, recall } = harness()
    const fixture = agentFixture()
    listenerFor(fake, 'agent/created')({ agent: fixture.agent })
    // The loop claims the user message before it assembles the first prompt.
    listenerFor(fake, 'agent/inbox/claimed')({
      agent: fixture.agent,
      message: userMessage(QUESTION),
      turn: 1,
    })
    const registration = fixture.registrations[0] as PromptContextRegistration
    const assembly = await assemble(fake, fixture.agent, registration)
    const memory = assembly.contexts.find((entry) => entry.name === 'cognee:memory')
    expect(memory?.text).toContain('amber-otter-7731')
    expect(memory?.text).toContain('CT 103')
    expect(recall.safeRecall).toHaveBeenCalledTimes(2)
  })

  it('leaves the assembly untouched for an unbound agent scope', async () => {
    const { fake } = harness()
    const stranger = { session: { id: 'unknown-session' } }
    const assembly = await assemble(fake, stranger, undefined)
    expect(assembly.contexts.map((entry) => entry.name)).toEqual(['persona'])
  })

  it('leaves the assembly untouched when memory is unavailable', async () => {
    const { fake, metrics } = harness([])
    const fixture = agentFixture('session-empty')
    listenerFor(fake, 'agent/created')({ agent: fixture.agent })
    listenerFor(fake, 'agent/inbox/claimed')({
      agent: fixture.agent,
      message: userMessage(QUESTION),
      turn: 1,
    })
    const registration = fixture.registrations[0] as PromptContextRegistration
    const assembly = await assemble(fake, fixture.agent, registration)
    expect(assembly.contexts.find((entry) => entry.name === 'cognee:memory')?.text).toBe('')
    expect(metrics.snapshot().counters['prefetch.empty']).toBe(1)
  })

  it('ignores runtime-context messages and assistant output', async () => {
    const { fake, recall } = harness()
    const fixture = agentFixture('session-ignored')
    listenerFor(fake, 'agent/created')({ agent: fixture.agent })
    const claimed = listenerFor(fake, 'agent/inbox/claimed')
    claimed({
      agent: fixture.agent,
      message: {
        id: 'ctx',
        role: 'user',
        source: { kind: 'runtime-context' },
        content: [{ type: 'text', text: QUESTION }],
      },
      turn: 1,
    })
    claimed({
      agent: fixture.agent,
      message: { id: 'a', role: 'assistant', content: [{ type: 'text', text: QUESTION }] },
      turn: 1,
    })
    expect(recall.safeRecall).not.toHaveBeenCalled()
  })

  it('keeps two agents with different scopes from sharing a block', async () => {
    const { fake, recall } = harness()
    const one = agentFixture('session-a')
    const two = agentFixture('session-b')
    listenerFor(fake, 'agent/created')({ agent: one.agent })
    listenerFor(fake, 'agent/created')({ agent: two.agent })
    listenerFor(fake, 'agent/inbox/claimed')({
      agent: one.agent,
      message: userMessage(QUESTION),
      turn: 1,
    })
    const assembly = await assemble(fake, two.agent, two.registrations[0] as PromptContextRegistration)
    expect(assembly.contexts.find((entry) => entry.name === 'cognee:memory')?.text).toBe('')
    expect(recall.safeRecall).toHaveBeenCalledTimes(2)
  })
})
