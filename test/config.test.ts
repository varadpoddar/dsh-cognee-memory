import { describe, expect, it } from 'vitest'
import {
  CogneeMemoryConfigSchema,
  DEFAULT_CONFIG,
  parseConfig,
  resolveTransport,
} from '../src/config/schema.js'

describe('config validation', () => {
  it('provides safe defaults', () => {
    expect(DEFAULT_CONFIG).toMatchObject({
      enabled: true,
      transport: 'auto',
      apiBaseUrl: 'http://127.0.0.1:8000/api/v1',
      // The live instance runs with ENABLE_BACKEND_ACCESS_CONTROL=true, so an
      // unauthenticated default would fail every call.
      authMode: 'api-key',
      apiTokenEnv: 'COGNEE_API_KEY',
      failureMode: 'open',
      circuitBreakerEnabled: true,
      maxRetries: 2,
      requestTimeoutMs: 120_000,
    })
    expect(DEFAULT_CONFIG.recall.searchType).toBe('CHUNKS')
    expect(DEFAULT_CONFIG.recall.maxRecallLatencyMs).toBe(3_000)
    expect(DEFAULT_CONFIG.ingestion.timeoutMs).toBeGreaterThan(0)
    expect(DEFAULT_CONFIG.prompt.maxItems).toBeGreaterThan(0)
    expect(DEFAULT_CONFIG.prompt.maxTokens).toBeGreaterThan(0)
  })

  it('parses an empty object and fills nested defaults', () => {
    const config = parseConfig({})
    expect(config.scopeDefaults).toEqual({})
    expect(config.prompt).toEqual({ maxItems: 5, maxTokens: 600, order: 9_000 })
    expect(config.security.redactionMode).toBe('reject')
    expect(config.tools.enabled).toBe(true)
  })

  it('merges partial nested config', () => {
    const config = parseConfig({ prompt: { maxItems: 2 }, security: { redactionMode: 'redact' } })
    expect(config.prompt.maxItems).toBe(2)
    expect(config.prompt.maxTokens).toBe(600)
    expect(config.security.redactionMode).toBe('redact')
  })

  it('rejects an unknown transport', () => {
    expect(() => parseConfig({ transport: 'carrier-pigeon' })).toThrowError(/invalid cognee memory config/)
  })

  it('requires mcpUrl for the explicit mcp-http transport', () => {
    expect(() => parseConfig({ transport: 'mcp-http' })).toThrowError(/mcpUrl is required/)
  })

  it('rejects the reserved mcp-stdio transport with a clear message', () => {
    expect(() => parseConfig({ transport: 'mcp-stdio' })).toThrowError(/mcp-stdio/)
  })

  it('rejects URLs with embedded credentials', () => {
    expect(() => parseConfig({ apiBaseUrl: 'http://user:pass@localhost:8000' })).toThrowError(
      /embedded credentials/,
    )
  })

  it('rejects non-http URLs', () => {
    expect(() => parseConfig({ apiBaseUrl: 'ftp://localhost:8000' })).toThrowError(/http\(s\)/)
  })

  it('enforces numeric bounds', () => {
    expect(() => parseConfig({ maxRetries: 99 })).toThrow()
    expect(() => parseConfig({ prompt: { maxTokens: 1 } })).toThrow()
    expect(() => parseConfig({ dedup: { nearDuplicateThreshold: 0.1 } })).toThrow()
    expect(() => parseConfig({ circuitBreakerThreshold: 0 })).toThrow()
  })

  it('rejects a blank token environment name', () => {
    expect(() => parseConfig({ apiTokenEnv: '   ' })).toThrow()
  })

  it('resolves auto by mcpUrl presence', () => {
    expect(resolveTransport(parseConfig({ transport: 'auto' }))).toBe('rest')
    expect(
      resolveTransport(parseConfig({ transport: 'auto', mcpUrl: 'http://127.0.0.1:8000/mcp' })),
    ).toBe('mcp-http')
    expect(resolveTransport(parseConfig({ transport: 'rest' }))).toBe('rest')
  })

  it('does not echo invalid input values in the config error', () => {
    const secret = 'sk-super-secret-value-that-must-not-appear'
    try {
      parseConfig({ transport: 'rest', apiBaseUrl: secret })
      throw new Error('expected rejection')
    } catch (error) {
      expect(String(error)).not.toContain(secret)
      expect(String(error)).toContain('apiBaseUrl')
    }
  })

  it('implements the synchronous Standard Schema contract', () => {
    const result = CogneeMemoryConfigSchema['~standard'].validate({ transport: 'rest' })
    expect(result).not.toBeInstanceOf(Promise)
    expect('value' in result).toBe(true)
  })
})
