import { CircuitOpenError, MemoryError, toMemoryError } from '../errors.js'

export type BreakerState = 'closed' | 'open' | 'half-open'

export interface CircuitBreakerOptions {
  readonly threshold: number
  readonly cooldownMs: number
  readonly now?: () => number
}

export interface BreakerSnapshot {
  readonly state: BreakerState
  readonly failures: number
  readonly retryAfterMs: number
}

/**
 * Consecutive-failure circuit breaker with a single half-open probe.
 * The clock is injectable so tests never sleep on wall time.
 */
export class CircuitBreaker {
  private state: BreakerState = 'closed'
  private failures = 0
  private openedAt = 0
  private probeInFlight = false
  private readonly threshold: number
  private readonly cooldownMs: number
  private readonly now: () => number

  constructor(options: CircuitBreakerOptions) {
    if (!Number.isInteger(options.threshold) || options.threshold < 1) {
      throw new MemoryError('CONFIG', 'circuit breaker threshold must be a positive integer')
    }
    if (!Number.isFinite(options.cooldownMs) || options.cooldownMs < 0) {
      throw new MemoryError('CONFIG', 'circuit breaker cooldown must be non-negative')
    }
    this.threshold = options.threshold
    this.cooldownMs = options.cooldownMs
    this.now = options.now ?? Date.now
  }

  /** Throws `CircuitOpenError` when this call must not reach the backend. */
  canRequest(): boolean {
    if (this.state === 'closed') return true
    if (this.state === 'open') {
      if (this.now() - this.openedAt >= this.cooldownMs) {
        this.state = 'half-open'
        this.probeInFlight = true
        return true
      }
      throw new CircuitOpenError(this.retryAfterMs())
    }
    if (this.probeInFlight) throw new CircuitOpenError(this.retryAfterMs())
    this.probeInFlight = true
    return true
  }

  recordSuccess(): void {
    this.state = 'closed'
    this.failures = 0
    this.probeInFlight = false
  }

  recordFailure(): void {
    this.probeInFlight = false
    if (this.state === 'half-open') {
      this.state = 'open'
      this.openedAt = this.now()
      return
    }
    this.failures += 1
    if (this.failures >= this.threshold) {
      this.state = 'open'
      this.openedAt = this.now()
    }
  }

  snapshot(): BreakerSnapshot {
    return {
      state: this.state,
      failures: this.failures,
      retryAfterMs: this.retryAfterMs(),
    }
  }

  private retryAfterMs(): number {
    if (this.state !== 'open') return 0
    return Math.max(0, this.cooldownMs - (this.now() - this.openedAt))
  }
}

export interface RetryOptions {
  readonly maxRetries: number
  readonly backoffMs: number
  readonly maxBackoffMs?: number
  readonly signal?: AbortSignal
  readonly shouldRetry?: (error: unknown) => boolean
  readonly onRetry?: (attempt: number, error: unknown, delayMs: number) => void
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>
  readonly random?: () => number
}

export function abortError(): MemoryError {
  return new MemoryError('TIMEOUT', 'memory operation aborted', { retryable: false })
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError()
}

/** Abortable sleep used by retries and tests. */
export function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    throwIfAborted(signal)
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    timer.unref?.()
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function defaultShouldRetry(error: unknown): boolean {
  return error instanceof MemoryError ? error.retryable : false
}

/**
 * Retry with bounded exponential backoff and optional jitter. Aborts promptly,
 * never retries non-retryable typed errors, and leaves the last error intact.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const maxRetries = Math.max(0, Math.trunc(options.maxRetries))
  const random = options.random ?? Math.random
  const maybeSleep = options.sleep ?? sleep
  let lastError: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    throwIfAborted(options.signal)
    try {
      return await operation(attempt)
    } catch (error) {
      lastError = error
      const retryable = (options.shouldRetry ?? defaultShouldRetry)(error)
      if (!retryable || attempt === maxRetries) throw error
      const exponential = options.backoffMs * 2 ** attempt
      const jitter = Math.floor(random() * options.backoffMs * 0.2)
      const delay = Math.min(options.maxBackoffMs ?? 30_000, exponential + jitter)
      options.onRetry?.(attempt + 1, error, delay)
      await maybeSleep(delay, options.signal)
    }
  }
  throw toMemoryError(lastError, 'UNAVAILABLE')
}

export interface TimeoutScope {
  readonly signal: AbortSignal
  readonly timedOut: () => boolean
  readonly dispose: () => void
}

/** Compose a per-request timeout with the caller's cancellation signal. */
export function createTimeoutScope(timeoutMs: number, parent?: AbortSignal): TimeoutScope {
  const controller = new AbortController()
  let didTimeout = false
  const onParentAbort = (): void => controller.abort(parent?.reason)
  if (parent?.aborted === true) {
    controller.abort(parent.reason)
  } else {
    parent?.addEventListener('abort', onParentAbort, { once: true })
  }
  const timer = setTimeout(() => {
    didTimeout = true
    controller.abort()
  }, timeoutMs)
  timer.unref?.()
  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    dispose: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onParentAbort)
    },
  }
}
