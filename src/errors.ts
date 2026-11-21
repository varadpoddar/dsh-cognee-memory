/**
 * Stable, machine-readable failures for the Cognee memory plugin.
 *
 * Messages are deliberately static: backend response bodies and secrets are
 * never copied into an error that may reach the model or a log line.
 */

export type MemoryErrorCode =
  | 'CONFIG'
  | 'VALIDATION'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNSUPPORTED_OPERATION'
  | 'TIMEOUT'
  | 'UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'BACKEND'
  | 'CIRCUIT_OPEN'
  | 'REDACTION_BLOCKED'
  | 'DISABLED'
  | 'INTERNAL'

export interface ToolErrorPayload {
  readonly code: MemoryErrorCode
  readonly message: string
  readonly retryable: boolean
  readonly details?: Readonly<Record<string, unknown>>
}

export interface MemoryErrorOptions {
  readonly retryable?: boolean
  readonly details?: Readonly<Record<string, unknown>>
  readonly cause?: unknown
}

/** One typed failure. `toToolError()` is safe to project to the model. */
export class MemoryError extends Error {
  readonly code: MemoryErrorCode
  readonly retryable: boolean
  readonly details?: Readonly<Record<string, unknown>>

  constructor(code: MemoryErrorCode, message: string, options: MemoryErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'MemoryError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.details = options.details
  }

  toToolError(): ToolErrorPayload {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
    }
  }
}

/**
 * Cognee does not prove a per-memory delete or update operation. The plugin
 * must never "make do" by deleting a whole dataset.
 */
export class UnsupportedOperationError extends MemoryError {
  readonly operation: string

  constructor(operation: string, detail = 'the configured Cognee API did not prove this operation') {
    super(
      'UNSUPPORTED_OPERATION',
      `${operation} is not supported by the configured Cognee backend (${detail}); ` +
        'refusing to substitute a destructive dataset operation',
      { retryable: false, details: { operation } },
    )
    this.name = 'UnsupportedOperationError'
    this.operation = operation
  }
}

/** Text was rejected because it contains credential material. */
export class RedactionBlockedError extends MemoryError {
  readonly kinds: readonly string[]

  constructor(kinds: readonly string[]) {
    super('REDACTION_BLOCKED', 'memory write rejected: text contains credential material', {
      retryable: false,
      details: { kinds: [...new Set(kinds)] },
    })
    this.name = 'RedactionBlockedError'
    this.kinds = Object.freeze([...new Set(kinds)])
  }
}

export class CircuitOpenError extends MemoryError {
  constructor(retryAfterMs?: number) {
    super('CIRCUIT_OPEN', 'memory backend circuit breaker is open', {
      retryable: false,
      ...(retryAfterMs === undefined ? {} : { details: { retryAfterMs } }),
    })
    this.name = 'CircuitOpenError'
  }
}

export function isMemoryError(value: unknown): value is MemoryError {
  return value instanceof MemoryError
}

/** Normalize an unknown thrown value without ever serializing its message from untrusted text. */
export function toMemoryError(value: unknown, fallbackCode: MemoryErrorCode = 'INTERNAL'): MemoryError {
  if (value instanceof MemoryError) return value
  if (value instanceof Error && value.name === 'AbortError') {
    return new MemoryError('TIMEOUT', 'memory operation aborted', { retryable: false, cause: value })
  }
  return new MemoryError(fallbackCode, 'memory operation failed', { retryable: false, cause: value })
}
