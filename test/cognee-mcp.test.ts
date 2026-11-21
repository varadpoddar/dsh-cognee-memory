import { afterEach, describe, expect, it } from 'vitest'
import { parseConfig, type CogneeMemoryConfig } from '../src/config/schema.js'
import { CogneeMcpAdapter, createCogneeMcpAdapter, parseMcpHttpBody } from '../src/adapters/cognee-mcp.js'
import { createMemoryAdapter } from '../src/adapters/memory-adapter.js'
import { COGNEE_MCP_TOOLS } from '../src/adapters/cognee-paths.js'
import { makeScopeRef, scopeKey } from '../src/memory/scopes.js'
import { startMockServer, type MockServer, type MockServerRequest } from './helpers/mock-server.js'

let server: MockServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

const project = makeScopeRef('project', '/workspace/demo')

function mcpConfig(mcpUrl: string): CogneeMemoryConfig {
  return parseConfig({
    transport: 'mcp-http',
    mcpUrl,
    apiBaseUrl: 'http://127.0.0.1:1',
    requestTimeoutMs: 1_000,
    maxRetries: 0,
    retryBackoffMs: 0,
  })
}

function rpcMethod(request: MockServerRequest): string | undefined {
  try {
    return (JSON.parse(request.body) as { method?: string }).method
  } catch {
    return undefined
  }
}

function initializeResponse(request: MockServerRequest) {
  if (rpcMethod(request) === 'initialize') {
    return {
      headers: { 'mcp-session-id': 'session-1' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'mock' } },
      }),
    }
  }
  if (rpcMethod(request) === 'notifications/initialized') return { status: 202, body: '' }
  return undefined
}

describe('parseMcpHttpBody', () => {
  it('parses SSE data events and takes the last JSON payload', () => {
    expect(parseMcpHttpBody('event: message\ndata: {"a":1}\n\ndata: {"a":2}\n\n', 'text/event-stream')).toEqual({
      a: 2,
    })
  })

  it('rejects malformed MCP bodies without echoing them', () => {
    expect(() => parseMcpHttpBody('not json secret', 'application/json')).toThrowError(/invalid MCP response/)
  })
})

describe('CogneeMcpAdapter', () => {
  it('initializes once, forwards the session header, and parses a remember result', async () => {
    server = await startMockServer((request) => {
      const initialized = initializeResponse(request)
      if (initialized !== undefined) return initialized
      if (rpcMethod(request) === 'tools/call') {
        const body = JSON.parse(request.body) as { params: { name: string; arguments: unknown } }
        expect(body.params.name).toBe(COGNEE_MCP_TOOLS.remember)
        return {
          sse: [
            JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              result: { structuredContent: { id: 'mcp-mem-1' } },
            }),
          ],
        }
      }
      return { status: 500 }
    })
    const adapter = createCogneeMcpAdapter({ config: mcpConfig(server.url) })
    const result = await adapter.remember({
      text: 'remember me',
      scope: project,
      provenance: {
        kind: 'tool_call',
        source: 'tool:memory_remember',
        recordedAt: '2026-01-01T00:00:00.000Z',
      },
    })
    expect(result).toMatchObject({ id: 'mcp-mem-1', scope: project })
    expect(server.requests).toHaveLength(3)
    expect(server.requests[0]?.headers['mcp-session-id']).toBeUndefined()
    expect(server.requests[2]?.headers['mcp-session-id']).toBe('session-1')
    const args = (
      JSON.parse(server.requests[2]?.body ?? '') as {
        params: { arguments: Record<string, unknown> }
      }
    ).params.arguments
    expect(args.datasetName).toBe(scopeKey(project))
  })

  it('parses recall rows from MCP text content', async () => {
    server = await startMockServer((request) => {
      const initialized = initializeResponse(request)
      if (initialized !== undefined) return initialized
      const body = JSON.parse(request.body) as { params: { name: string } }
      if (body.params.name === COGNEE_MCP_TOOLS.recall) {
        return {
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    results: [
                      { id: 'r1', text: 'recalled', dataset_name: scopeKey(project), score: 0.75 },
                    ],
                  }),
                },
              ],
            },
          }),
        }
      }
      return { status: 500 }
    })
    const adapter = createCogneeMcpAdapter({ config: mcpConfig(server.url) })
    const hits = await adapter.recall({ text: 'recalled', scopes: [project], limit: 5 })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.record.text).toBe('recalled')
    expect(hits[0]?.score).toBe(0.75)
  })

  it('maps JSON-RPC method-not-found to unsupported operation', async () => {
    server = await startMockServer((request) => {
      const initialized = initializeResponse(request)
      if (initialized !== undefined) return initialized
      return {
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'nope' } }),
      }
    })
    const adapter = createCogneeMcpAdapter({ config: mcpConfig(server.url) })
    await expect(adapter.forget({ id: 'x', scope: project })).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
    })
  })

  it('surfaces HTTP 404 on forget as unsupported operation', async () => {
    server = await startMockServer((request) => {
      const initialized = initializeResponse(request)
      if (initialized !== undefined) return initialized
      return { status: 404 }
    })
    const adapter = createCogneeMcpAdapter({ config: mcpConfig(server.url) })
    await expect(adapter.forget({ id: 'x', scope: project })).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      operation: 'forget',
    })
  })

  it('reports status/health from initialization without a status tool', async () => {
    server = await startMockServer((request) => initializeResponse(request) ?? { status: 500 })
    const adapter = createCogneeMcpAdapter({ config: mcpConfig(server.url) })
    await expect(adapter.status()).resolves.toMatchObject({ transport: 'mcp-http', reachable: true })
    await expect(adapter.health()).resolves.toMatchObject({ ok: true })
  })
})

describe('createMemoryAdapter', () => {
  it('resolves auto to REST when no mcpUrl is configured', () => {
    const config = parseConfig({ transport: 'auto', apiBaseUrl: 'http://127.0.0.1:9' })
    const adapter = createMemoryAdapter({ config })
    expect(adapter.constructor.name).toBe('CogneeRestAdapter')
  })

  it('resolves auto to MCP HTTP when mcpUrl is configured', () => {
    const config = parseConfig({
      transport: 'auto',
      mcpUrl: 'http://127.0.0.1:9/mcp',
      apiBaseUrl: 'http://127.0.0.1:9',
    })
    const adapter = createMemoryAdapter({ config })
    expect(adapter.constructor.name).toBe('CogneeMcpAdapter')
  })

  it('fails closed for the reserved mcp-stdio transport', () => {
    const config = parseConfig({ transport: 'rest', apiBaseUrl: 'http://127.0.0.1:9' })
    const invalid = { ...config, transport: 'mcp-stdio' as const }
    expect(() => createMemoryAdapter({ config: invalid })).toThrowError(/mcp-stdio transport is not implemented/)
  })
})
