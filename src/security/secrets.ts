import { MemoryError } from '../errors.js'
import type { CogneeMemoryConfig } from '../config/schema.js'

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/

/** Validate an environment variable name without reading or echoing its value. */
export function assertEnvVarName(name: string): string {
  if (!ENV_NAME.test(name)) {
    throw new MemoryError('CONFIG', 'apiTokenEnv must be an upper-case environment variable name')
  }
  return name
}

export interface SecretResolver {
  has(name: string): boolean
  require(name: string): string
}

/** Environment-only secret resolution. Missing values fail closed. */
export function createEnvSecretResolver(env: NodeJS.ProcessEnv = process.env): SecretResolver {
  return {
    has: (name) => {
      const value = env[assertEnvVarName(name)]
      return typeof value === 'string' && value.trim() !== ''
    },
    require: (name) => {
      const value = env[assertEnvVarName(name)]
      if (typeof value !== 'string' || value.trim() === '') {
        throw new MemoryError('CONFIG', `missing required environment variable ${name}`)
      }
      return value.trim()
    },
  }
}

/** Headers for the configured Cognee auth mode. Values never leave this module unredacted. */
export function buildAuthHeaders(
  config: Pick<CogneeMemoryConfig, 'authMode' | 'apiTokenEnv'>,
  resolver: SecretResolver = createEnvSecretResolver(),
): Record<string, string> {
  if (config.authMode === 'none') return {}
  const token = resolver.require(assertEnvVarName(config.apiTokenEnv))
  if (config.authMode === 'api-key') return { 'X-Api-Key': token }
  return { Authorization: `Bearer ${token}` }
}

/** Header projection safe for logs and `status` output. */
export function redactHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const redacted: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = /authorization|api-key|token|secret/i.test(key) ? '[REDACTED]' : value
  }
  return redacted
}

/** Endpoint projection without userinfo, query, or fragment (all may carry secrets). */
export function safeEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    const path = url.pathname === '/' ? '' : url.pathname
    return `${url.protocol}//${url.host}${path}`
  } catch {
    return '<invalid-url>'
  }
}
