import { describe, expect, it } from 'vitest'
import { Metrics } from '../src/telemetry/metrics.js'

describe('Metrics', () => {
  it('counts allowlisted names and zero-fills the snapshot', () => {
    const metrics = new Metrics()
    metrics.increment('recall.requests')
    metrics.increment('recall.requests', 2)
    expect(metrics.snapshot().counters['recall.requests']).toBe(3)
    expect(metrics.snapshot().counters['remember.requests']).toBe(0)
  })

  it('ignores unknown metric names to keep cardinality bounded', () => {
    const metrics = new Metrics()
    metrics.increment('secret.user.label' as never)
    expect(metrics.snapshot().counters['secret.user.label']).toBeUndefined()
  })

  it('records a safe error code and resets cleanly', () => {
    const metrics = new Metrics(() => new Date('2026-01-01T00:00:00.000Z'))
    metrics.recordError('TIMEOUT')
    expect(metrics.snapshot()).toMatchObject({
      lastErrorCode: 'TIMEOUT',
      lastErrorAt: '2026-01-01T00:00:00.000Z',
    })
    metrics.reset()
    expect(metrics.snapshot()).toEqual({
      counters: expect.objectContaining({ 'recall.requests': 0 }),
      samples: {
        'recall.latencyMs': { count: 0, p50: 0, p95: 0, max: 0, last: 0 },
        'prefetch.latencyMs': { count: 0, p50: 0, p95: 0, max: 0, last: 0 },
        'context.usage': { count: 0, p50: 0, p95: 0, max: 0, last: 0 },
      },
    })
  })

  it('summarizes bounded latency samples as p50/p95', () => {
    const metrics = new Metrics()
    for (let value = 1; value <= 100; value += 1) metrics.observe('recall.latencyMs', value)
    metrics.observe('recall.latencyMs', Number.NaN)
    const summary = metrics.snapshot().samples['recall.latencyMs']
    expect(summary.count).toBe(100)
    expect(summary.p50).toBe(50)
    expect(summary.p95).toBe(95)
    expect(summary.max).toBe(100)
  })

  it('keeps the sample reservoir bounded', () => {
    const metrics = new Metrics()
    for (let value = 0; value < 1_000; value += 1) metrics.observe('context.usage', value)
    expect(metrics.snapshot().samples['context.usage'].count).toBe(256)
  })
})
