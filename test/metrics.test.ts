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
    })
  })
})
