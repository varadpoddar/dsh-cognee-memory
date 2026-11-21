import { MemoryError, UnsupportedOperationError, isMemoryError } from '../errors.js'
import type { CogneeMemoryConfig } from '../config/schema.js'
import { buildAuthHeaders, createEnvSecretResolver } from '../security/secrets.js'
import type { Metrics } from '../telemetry/metrics.js'
import {
  CircuitBreaker,
  createTimeoutScope,
  sleep as defaultSleep,
  withRetry,
} from './resilience.js'

export interface HttpJsonClientOptions {
  readonly config: CogneeMemoryConfig
  readonly env?: NodeJS.ProcessEnv
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>
  readonly random?: () => number
  readonly metrics?: Metrics
}

export interface HttpRequestOptions {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Path relative to the configured base URL; '' targets the base URL itself. */
  readonly path: string
  readonly body?: unknown
  readonly signal?: AbortSignal
  /** Operation name used in safe error details and unsupported-operation errors. */
  readonly operation: string
  readonly unsupportedStatuses?: readonly number[]
  readonly headers?: Readonly<Record<string, string>>
  /** Override the configured request timeout (e.g. a short connection probe). */
  readonly timeoutMs?: number
}

export interface HttpResult {
  readonly status: number
  readonly headers: Headers
  readonly text: string
  readonly url: string
}

/** Join a base URL and path. A path of '' preserves the base URL exactly. */
export function joinEndpoint(baseUrl: string, path: string): string {
  if (path === '') return baseUrl
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return new URL(path.replace(/^\/+/, ''), base).toString()
}

function timeoutError(message = 'memory backend request timed out'): MemoryError {
  return new MemoryError('TIMEOUT', message, { retryable: true })
}

function unavailableError(): MemoryError {
  return new MemoryError('UNAVAILABLE', 'memory backend is unavailable', { retryable: true })
}

function statusError(
  status: number,
  operation: string,
  unsupportedStatuses: readonly number[] | undefined,
): MemoryError {
  const details = { status, operation }
  if (unsupportedStatuses?.includes(status) === true) {
    return new UnsupportedOperationError(operation, `backend returned HTTP ${status}`)
  }
  if (status === 401) return new MemoryError('UNAUTHORIZED', 'memory backend rejected credentials', { details })
  if (status === 403) return new MemoryError('FORBIDDEN', 'memory backend denied the request', { details })
  if (status === 404) return new MemoryError('NOT_FOUND', 'memory record or endpoint was not found', { details })
  if (status === 405) return new MemoryError('UNSUPPORTED_OPERATION', 'memory backend rejected the HTTP method', { details })
  if (status === 409) return new MemoryError('CONFLICT', 'memory backend reported a conflict', { details })
  if (status === 408) return timeoutError()
  if (status === 429) {
    return new MemoryError('RATE_LIMITED', 'memory backend rate limit reached', { retryable: true, details })
  }
  if (status >= 500) {
    return new MemoryError('BACKEND', 'memory backend failed', { retryable: true, details })
  }
  if (status >= 400) {
    return new MemoryError('BACKEND', 'memory backend rejected the request', { details })
  }
  return new MemoryError('BACKEND', 'unexpected memory backend response', { details })
}

/**
 * Small JSON-over-HTTP client with one auth path, caller-signal composition,
 * bounded retries, and an availability circuit breaker. Response bodies are
 * never included in errors, because a backend may echo credentials.
 */
export class HttpJsonClient {
  private readonly config: CogneeMemoryConfig
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly breaker: CircuitBreaker | undefined
  private readonly metrics: Metrics | undefined
  private readonly resolver: ReturnType<typeof createEnvSecretResolver>
  private readonly sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>
  private readonly random: () => number
  private readonly now: () => number

  constructor(options: HttpJsonClientOptions) {
    this.config = options.config
    this.baseUrl = options.config.apiBaseUrl
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
    this.metrics = options.metrics
    this.resolver = createEnvSecretResolver(options.env ?? process.env)
    this.sleep = options.sleep ?? defaultSleep
    this.random = options.random ?? Math.random
    this.now = options.now ?? Date.now
    this.breaker = options.config.circuitBreakerEnabled
      ? new CircuitBreaker({
          threshold: options.config.circuitBreakerThreshold,
          cooldownMs: options.config.circuitBreakerCooldownMs,
          now: this.now,
        })
      : undefined
  }

  breakerSnapshot(): ReturnType<CircuitBreaker['snapshot']> | undefined {
    return this.breaker?.snapshot()
  }

  async request(options: HttpRequestOptions): Promise<HttpResult> {
    const url = joinEndpoint(this.baseUrl, options.path)
    const authHeaders = buildAuthHeaders(this.config, this.resolver)
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...authHeaders,
      ...options.headers,
    }
    const body = options.body === undefined ? undefined : JSON.stringify(options.body)

    const attempt = async (): Promise<HttpResult> => {
      if (this.breaker !== undefined) {
        try {
          this.breaker.canRequest()
        } catch (error) {
          this.metrics?.increment('circuit.open')
          throw error
        }
      }
      const timeout = createTimeoutScope(options.timeoutMs ?? this.config.requestTimeoutMs, options.signal)
      let response: Response
      let text: string
      try {
        response = await this.fetchImpl(url, {
          method: options.method,
          headers,
          ...(body === undefined ? {} : { body }),
          signal: timeout.signal,
        })
        text = await response.text()
      } catch (error) {
        this.breaker?.recordFailure()
        if (timeout.timedOut()) {
          this.metrics?.increment('adapter.timeouts')
          throw timeoutError()
        }
        if (options.signal?.aborted === true) throw timeoutError('memory operation aborted')
        if (isMemoryError(error)) throw error
        throw unavailableError()
      } finally {
        timeout.dispose()
      }

      const retryableStatus =
        response.status >= 500 || response.status === 429 || response.status === 408
      if (!response.ok) {
        if (retryableStatus) this.breaker?.recordFailure()
        else this.breaker?.recordSuccess()
        throw statusError(response.status, options.operation, options.unsupportedStatuses)
      }
      this.breaker?.recordSuccess()
      return { status: response.status, headers: response.headers, text, url }
    }

    return withRetry(attempt, {
      maxRetries: this.config.maxRetries,
      backoffMs: this.config.retryBackoffMs,
      signal: options.signal,
      sleep: this.sleep,
      random: this.random,
      onRetry: () => this.metrics?.increment('retry.attempts'),
    })
  }

  async requestJson<T = unknown>(options: HttpRequestOptions): Promise<T | undefined> {
    const result = await this.request(options)
    if (result.text.trim() === '') return undefined
    try {
      return JSON.parse(result.text) as T
    } catch {
      throw new MemoryError('BACKEND', 'invalid JSON response from memory backend')
    }
  }
}
