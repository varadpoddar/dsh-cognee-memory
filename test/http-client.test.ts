import { afterEach, describe, expect, it } from 'vitest'
import { parseConfig, type CogneeMemoryConfig } from '../src/config/schema.js'
import { HttpJsonClient, joinEndpoint } from '../src/adapters/http-client.js'
import { startMockServer, type MockServer } from './helpers/mock-server.js'

let server: MockServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

function config(baseUrl: string, overrides: Record<string, unknown> = {}): CogneeMemoryConfig {
  return parseConfig({
    transport: 'rest',
    apiBaseUrl: baseUrl,
    requestTimeoutMs: 1_000,
    maxRetries: 0,
    retryBackoffMs: 0,
    ...overrides,
  })
}

describe('joinEndpoint', () => {
  it('preserves a pathless base URL and joins REST paths', () => {
    expect(joinEndpoint('http://127.0.0.1:8000', '/api/v1/add')).toBe('http://127.0.0.1:8000/api/v1/add')
    expect(joinEndpoint('http://127.0.0.1:8000/', '/api/v1/add')).toBe('http://127.0.0.1:8000/api/v1/add')
  })

  it('preserves an explicit MCP path when the relative path is empty', () => {
    expect(joinEndpoint('http://127.0.0.1:8000/mcp', '')).toBe('http://127.0.0.1:8000/mcp')
  })
})

describe('HttpJsonClient', () => {
  it('sends JSON, returns parsed data, and records the request', async () => {
    server = await startMockServer(() => ({ body: JSON.stringify({ ok: true, items: [1] }) }))
    const client = new HttpJsonClient({ config: config(server.url) })
    const response = await client.requestJson<{ ok: boolean; items: number[] }>({
      method: 'POST',
      path: '/api/v1/add',
      operation: 'remember',
      body: { data: 'hello' },
    })
    expect(response).toEqual({ ok: true, items: [1] })
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]?.method).toBe('POST')
    expect(server.requests[0]?.url).toBe('/api/v1/add')
    expect(JSON.parse(server.requests[0]?.body ?? '')).toEqual({ data: 'hello' })
    expect(server.requests[0]?.headers['content-type']).toBe('application/json')
  })

  it('adds bearer auth only from the configured environment variable', async () => {
    server = await startMockServer(() => ({ body: '{}' }))
    const client = new HttpJsonClient({
      config: config(server.url, { authMode: 'bearer', apiTokenEnv: 'COGNEE_TEST_TOKEN' }),
      env: { COGNEE_TEST_TOKEN: 'super-secret-token' },
    })
    await client.request({ method: 'GET', path: '/api/v1/datasets', operation: 'status' })
    expect(server.requests[0]?.headers.authorization).toBe('Bearer super-secret-token')
  })

  it('fails closed without leaking a missing token', async () => {
    server = await startMockServer(() => ({ body: '{}' }))
    const client = new HttpJsonClient({
      config: config(server.url, { authMode: 'bearer', apiTokenEnv: 'MISSING_TOKEN' }),
      env: {},
    })
    await expect(
      client.request({ method: 'GET', path: '/api/v1/datasets', operation: 'status' }),
    ).rejects.toMatchObject({ code: 'CONFIG', message: expect.stringContaining('MISSING_TOKEN') })
    expect(server.requests).toHaveLength(0)
  })

  it('maps 401 without retrying', async () => {
    server = await startMockServer(() => ({ status: 401 }))
    const client = new HttpJsonClient({ config: config(server.url, { maxRetries: 2 }) })
    await expect(
      client.request({ method: 'GET', path: '/api/v1/datasets', operation: 'status' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(server.requests).toHaveLength(1)
  })

  it('maps 403 without retrying', async () => {
    server = await startMockServer(() => ({ status: 403 }))
    const client = new HttpJsonClient({ config: config(server.url, { maxRetries: 2 }) })
    await expect(
      client.request({ method: 'GET', path: '/api/v1/datasets', operation: 'status' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(server.requests).toHaveLength(1)
  })

  it('retries 5xx with bounded backoff and then succeeds', async () => {
    server = await startMockServer((_request, index) =>
      index < 2 ? { status: 503, body: 'unavailable' } : { body: '{"ok":true}' },
    )
    const delays: number[] = []
    const client = new HttpJsonClient({
      config: config(server.url, { maxRetries: 2, retryBackoffMs: 100 }),
      sleep: async (delay) => {
        delays.push(delay)
      },
      random: () => 0,
    })
    const result = await client.requestJson({ method: 'GET', path: '/health', operation: 'health' })
    expect(result).toEqual({ ok: true })
    expect(server.requests).toHaveLength(3)
    expect(delays).toEqual([100, 200])
  })

  it('stops after maxRetries and keeps the typed backend error', async () => {
    server = await startMockServer(() => ({ status: 500 }))
    const client = new HttpJsonClient({
      config: config(server.url, { maxRetries: 1, retryBackoffMs: 0 }),
    })
    await expect(
      client.request({ method: 'GET', path: '/health', operation: 'health' }),
    ).rejects.toMatchObject({ code: 'BACKEND', retryable: true })
    expect(server.requests).toHaveLength(2)
  })

  it('maps an exceeded request timeout to TIMEOUT', async () => {
    server = await startMockServer(() => ({ delayMs: 200, body: '{}' }))
    const client = new HttpJsonClient({
      config: config(server.url, { requestTimeoutMs: 100, maxRetries: 0 }),
    })
    await expect(
      client.request({ method: 'GET', path: '/health', operation: 'health' }),
    ).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true })
  })

  it('opens the circuit after the threshold and recovers through one half-open probe', async () => {
    let now = 0
    let fail = true
    server = await startMockServer(() => (fail ? { status: 503 } : { body: '{"ok":true}' }))
    const client = new HttpJsonClient({
      config: config(server.url, {
        maxRetries: 0,
        circuitBreakerEnabled: true,
        circuitBreakerThreshold: 2,
        circuitBreakerCooldownMs: 1_000,
      }),
      now: () => now,
    })
    await expect(client.request({ method: 'GET', path: '/health', operation: 'health' })).rejects.toMatchObject({
      code: 'BACKEND',
    })
    await expect(client.request({ method: 'GET', path: '/health', operation: 'health' })).rejects.toMatchObject({
      code: 'BACKEND',
    })
    expect(client.breakerSnapshot()?.state).toBe('open')
    await expect(client.request({ method: 'GET', path: '/health', operation: 'health' })).rejects.toMatchObject({
      code: 'CIRCUIT_OPEN',
    })
    expect(server.requests).toHaveLength(2)
    now = 1_000
    fail = false
    await expect(client.request({ method: 'GET', path: '/health', operation: 'health' })).resolves.toMatchObject({
      status: 200,
    })
    expect(client.breakerSnapshot()?.state).toBe('closed')
  })

  it('does not trip the breaker for a reachable 401', async () => {
    server = await startMockServer(() => ({ status: 401 }))
    const client = new HttpJsonClient({
      config: config(server.url, {
        maxRetries: 0,
        circuitBreakerThreshold: 1,
        circuitBreakerCooldownMs: 1_000,
      }),
    })
    await expect(
      client.request({ method: 'GET', path: '/health', operation: 'health' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(client.breakerSnapshot()).toMatchObject({ state: 'closed', failures: 0 })
  })

  it('rejects invalid JSON without exposing the response body', async () => {
    server = await startMockServer(() => ({ body: 'not json: secret-like-body' }))
    const client = new HttpJsonClient({ config: config(server.url) })
    await expect(
      client.requestJson({ method: 'GET', path: '/api/v1/datasets', operation: 'status' }),
    ).rejects.toMatchObject({
      code: 'BACKEND',
      message: expect.not.stringContaining('secret-like-body'),
    })
  })

  it('turns configured 404/405/501 statuses into an unsupported-operation error', async () => {
    server = await startMockServer(() => ({ status: 404 }))
    const client = new HttpJsonClient({ config: config(server.url) })
    await expect(
      client.request({
        method: 'DELETE',
        path: '/api/v1/delete',
        operation: 'forget',
        unsupportedStatuses: [404, 405, 501],
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION', operation: 'forget' })
  })
})
