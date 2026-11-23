import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { MemoryError } from '../src/errors.js'
import { identity, createHarness, record } from './helpers/fake-coordinator.js'
import {
  COGNEE_SERVICE_NAME,
  createCogneeService,
  registerCogneeService,
  type CogneeServiceApi,
} from '../src/service/cognee.js'
import type { PluginContextLike } from '../src/types.js'

/** Let a freshly loaded cordis plugin finish its apply/active transition. */
function tick(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('ctx.cognee service registration', () => {
  it('is resolvable from a second plugin and answers a recall', async () => {
    const harness = createHarness({
      async recall() {
        return [record('mem-9', 'staging deploys go out on Thursdays')]
      },
    })
    const root = new Context()
    const provider = {
      name: 'cognee-provider',
      apply(ctx: Context) {
        registerCogneeService(ctx as unknown as PluginContextLike, {
          coordinator: harness.coordinator,
          config: harness.config,
          metrics: harness.metrics,
        })
      },
    }
    let seen: unknown
    const seenHits: string[] = []
    const consumer = {
      name: 'cognee-consumer',
      inject: ['cognee'],
      apply(ctx: Context) {
        seen = ctx.get(COGNEE_SERVICE_NAME)
        const service = (ctx as unknown as { cognee: CogneeServiceApi }).cognee
        void service
          .recall('staging deploys', { identity: identity() })
          .then((hits) => seenHits.push(...hits.map((hit) => hit.record.text)))
      },
    }
    const providerFiber = root.plugin(provider)
    await tick()
    root.plugin(consumer)
    await tick(20)

    expect(seen).toBeDefined()
    expect(typeof (seen as CogneeServiceApi).recall).toBe('function')
    expect(seenHits).toEqual(['staging deploys go out on Thursdays'])
    await providerFiber.dispose()
  })

  it('is removed from the container when the providing fiber unloads', async () => {
    const harness = createHarness()
    const root = new Context()
    const fiber = root.plugin({
      name: 'cognee-provider',
      apply(ctx: Context) {
        registerCogneeService(ctx as unknown as PluginContextLike, {
          coordinator: harness.coordinator,
          config: harness.config,
        })
      },
    })
    await tick()
    expect(root.get(COGNEE_SERVICE_NAME)).toBeDefined()
    await fiber.dispose()
    await tick()
    expect(root.get(COGNEE_SERVICE_NAME)).toBeUndefined()
  })

  it('honours the disposer returned by registration', async () => {
    const harness = createHarness()
    const root = new Context()
    let disposeRegistration: (() => void) | undefined
    const fiber = root.plugin({
      name: 'cognee-provider',
      apply(ctx: Context) {
        disposeRegistration = registerCogneeService(ctx as unknown as PluginContextLike, {
          coordinator: harness.coordinator,
          config: harness.config,
        })
      },
    })
    await tick()
    expect(root.get(COGNEE_SERVICE_NAME)).toBeDefined()
    disposeRegistration?.()
    await tick()
    expect(root.get(COGNEE_SERVICE_NAME)).toBeUndefined()
    await fiber.dispose()
  })

  it('registers nothing (and never throws) on a context without provide', () => {
    const harness = createHarness()
    const bare = {} as PluginContextLike
    expect(() =>
      registerCogneeService(bare, { coordinator: harness.coordinator, config: harness.config }),
    ).not.toThrow()
  })
})

describe('ctx.cognee authorization and degradation', () => {
  it('enforces the same write policy as the tools (FORBIDDEN is not swallowed)', async () => {
    const harness = createHarness()
    const service = createCogneeService({
      coordinator: harness.coordinator,
      config: harness.config,
    })
    await expect(
      service.remember({ text: 'nope', scopeName: 'session' }, { identity: {} }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(harness.calls.remember).toHaveLength(0)
  })

  it('returns the readable scopes for an identity through the same policy', async () => {
    const harness = createHarness()
    const service = createCogneeService({
      coordinator: harness.coordinator,
      config: harness.config,
    })
    const scopes = await service.scopesFor(identity())
    expect(scopes.map((scope) => scope.scope)).toContain('project')
  })

  it('degrades recall to empty and status to reachable:false when Cognee is down', async () => {
    const harness = createHarness({
      async recall() {
        throw new MemoryError('UNAVAILABLE', 'backend down', { retryable: true })
      },
      async status() {
        throw new MemoryError('UNAVAILABLE', 'backend down', { retryable: true })
      },
    })
    const service = createCogneeService({
      coordinator: harness.coordinator,
      config: harness.config,
      metrics: harness.metrics,
    })
    await expect(service.recall('anything', { identity: identity() })).resolves.toEqual([])
    await expect(service.status()).resolves.toMatchObject({
      reachable: false,
      endpoint: harness.config.apiBaseUrl,
    })
    expect(harness.metrics.snapshot().counters['cognee.service.degraded']).toBeGreaterThan(0)
  })

  it('surfaces a write failure instead of pretending success', async () => {
    const harness = createHarness({
      async remember() {
        throw new MemoryError('UNAVAILABLE', 'backend down', { retryable: true })
      },
    })
    const service = createCogneeService({
      coordinator: harness.coordinator,
      config: harness.config,
    })
    await expect(
      service.remember({ text: 'durable fact' }, { identity: identity() }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })
})
