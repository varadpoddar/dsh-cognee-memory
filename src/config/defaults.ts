import { DEFAULT_CONFIG } from './schema.js'

/** Re-export the parsed defaults; `defaults.ts` is the documented import site. */
export { DEFAULT_CONFIG }
export const DEFAULT_PROMPT_LIMITS = Object.freeze({
  maxItems: DEFAULT_CONFIG.prompt.maxItems,
  maxTokens: DEFAULT_CONFIG.prompt.maxTokens,
  order: DEFAULT_CONFIG.prompt.order,
})
export const DEFAULT_RETRY = Object.freeze({
  connectionTimeoutMs: DEFAULT_CONFIG.connectionTimeoutMs,
  requestTimeoutMs: DEFAULT_CONFIG.requestTimeoutMs,
  maxRetries: DEFAULT_CONFIG.maxRetries,
  retryBackoffMs: DEFAULT_CONFIG.retryBackoffMs,
})
