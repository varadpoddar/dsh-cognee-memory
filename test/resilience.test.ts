import { describe, expect, it, vi } from 'vitest'
import { MemoryError } from '../src/errors.js'
import {
  CircuitBreaker,
  createTimeoutScope,
  withRetry,
} from '../src/adapters/resilience.js'

describe('withRetry', () => {
  it('does not sleep on first success', async () => {
    const sleep = vi.fn(async () => {})
    await expect(
      withRetry(async () => 'ok', { maxRetries: 2, backoffMs: 100, sleep }),
    ).resolves.toBe('ok')
    expect(sleep).not.toHaveBeenCalled()
  })

  it('retries retryable failures with exponential backoff and zero jitter', async () => {
    let attempts = 0
    const delays: number[] = []
    const result = await withRetry(
      async () => {
        attempts += 1
        if (attempts < 3) throw new MemoryError('UNAVAILABLE', 'offline', { retryable: true })
        return 'ok'
      },
      {
        maxRetries: 2,
        backoffMs: 100,
        random: () => 0,
        sleep: async (delay) => {
          delays.push(delay)
        },
      },
    )
    expect(result).toBe('ok')
    expect(attempts).toBe(3)
    expect(delays).toEqual([100, 200])
  })

  it('does not retry a non-retryable error', async () => {
    const operation = vi.fn(async () => {
      throw new MemoryError('VALIDATION', 'bad input')
    })
    await expect(withRetry(operation, { maxRetries: 3, backoffMs: 0 })).rejects.toMatchObject({
      code: 'VALIDATION',
    })
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('rethrows the last retryable error after the budget', async () => {
    let count = 0
    await expect(
      withRetry(
        async () => {
          count += 1
          throw new MemoryError('BACKEND', 'still failing', { retryable: true })
        },
        { maxRetries: 2, backoffMs: 0, sleep: async () => {} },
      ),
    ).rejects.toMatchObject({ code: 'BACKEND' })
    expect(count).toBe(3)
  })

  it('stops immediately when the signal is aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      withRetry(async () => 'never', { maxRetries: 2, backoffMs: 0, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
  })
})

describe('CircuitBreaker', () => {
  it('opens after the threshold, rejects requests, and probes after cooldown', () => {
    let now = 0
    const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 100, now: () => now })
    breaker.recordFailure()
    breaker.recordFailure()
    expect(breaker.snapshot()).toMatchObject({ state: 'open', failures: 2 })
    expect(() => breaker.canRequest()).toThrow(/circuit breaker is open/)
    now = 100
    expect(breaker.canRequest()).toBe(true)
    expect(breaker.snapshot().state).toBe('half-open')
    // Only one half-open probe may run at a time.
    expect(() => breaker.canRequest()).toThrow()
    breaker.recordSuccess()
    expect(breaker.snapshot()).toMatchObject({ state: 'closed', failures: 0 })
  })

  it('reopens when the half-open probe fails', () => {
    let now = 0
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 50, now: () => now })
    breaker.recordFailure()
    now = 50
    expect(breaker.canRequest()).toBe(true)
    breaker.recordFailure()
    expect(breaker.snapshot().state).toBe('open')
    expect(breaker.snapshot().retryAfterMs).toBe(50)
  })

  it('validates constructor options', () => {
    expect(() => new CircuitBreaker({ threshold: 0, cooldownMs: 1 })).toThrow(/threshold/)
    expect(() => new CircuitBreaker({ threshold: 1, cooldownMs: -1 })).toThrow(/cooldown/)
  })
})

describe('createTimeoutScope', () => {
  it('aborts on timeout and reports it', async () => {
    const scope = createTimeoutScope(5)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(scope.signal.aborted).toBe(true)
    expect(scope.timedOut()).toBe(true)
    scope.dispose()
  })

  it('forwards parent cancellation', () => {
    const parent = new AbortController()
    const scope = createTimeoutScope(1_000, parent.signal)
    parent.abort()
    expect(scope.signal.aborted).toBe(true)
    expect(scope.timedOut()).toBe(false)
    scope.dispose()
  })
})
