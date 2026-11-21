import { afterEach, describe, expect, it } from 'vitest'
import { parseConfig, type CogneeMemoryConfig } from '../src/config/schema.js'
import { CogneeRestAdapter, createCogneeRestAdapter } from '../src/adapters/cognee-rest.js'
import { COGNEE_PATHS } from '../src/adapters/cognee-paths.js'
import { makeScopeRef, scopeKey } from '../src/memory/scopes.js'
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

const project = makeScopeRef('project', '/workspace/demo')
const session = makeScopeRef('session', 'session-a')

describe('CogneeRestAdapter', () => {
  it('writes a scoped memory and parses the returned id', async () => {
    server = await startMockServer(() => ({ body: JSON.stringify({ id: 'mem-1' }) }))
    const adapter = new CogneeRestAdapter({ config: config(server.url) })
    const result = await adapter.remember({
      text: 'The deploy target is blue.',
      scope: project,
      tags: ['ops'],
      provenance: {
        kind: 'tool_call',
        source: 'tool:memory_remember',
        recordedAt: '2026-01-01T00:00:00.000Z',
      },
      dedupeKey: 'dedupe-1',
    })
    expect(result).toMatchObject({ id: 'mem-1', scope: project, deduplicated: false })
    const request = server.requests[0]
    expect(request?.method).toBe('POST')
    expect(request?.url).toBe(COGNEE_PATHS.add)
    const body = JSON.parse(request?.body ?? '') as Record<string, unknown>
    expect(body.data).toBe('The deploy target is blue.')
    expect(body.datasetName).toBe(scopeKey(project))
    expect(body.nodeSet).toEqual(['ops'])
    expect(body.dedupeKey).toBe('dedupe-1')
  })

  it('falls back to a deterministic local id when the backend omits one', async () => {
    server = await startMockServer(() => ({ body: '{}' }))
    const adapter = new CogneeRestAdapter({ config: config(server.url) })
    const input = {
      text: 'same text',
      scope: project,
      provenance: {
        kind: 'tool_call' as const,
        source: 'tool:memory_remember',
        recordedAt: '2026-01-01T00:00:00.000Z',
      },
      dedupeKey: 'stable-key',
    }
    const first = await adapter.remember(input)
    const second = await adapter.remember(input)
    expect(first.id).toMatch(/^local-/)
    expect(first.id).toBe(second.id)
  })

  it('parses recall rows and drops rows from unknown datasets', async () => {
    server = await startMockServer(() => ({
      body: JSON.stringify([
        { id: 'p1', text: 'project memory', dataset_name: scopeKey(project), score: 0.9 },
        { id: 's1', text: 'session memory', dataset_name: scopeKey(session), score: 1.7 },
        { id: 'x1', text: 'foreign memory', dataset_name: 'other_tenant_dataset', score: 1 },
      ]),
    }))
    const adapter = new CogneeRestAdapter({ config: config(server.url) })
    const hits = await adapter.recall({
      text: 'memory',
      scopes: [project, session],
      limit: 5,
    })
    expect(hits).toHaveLength(2)
    expect(hits[0]?.record).toMatchObject({ id: 'p1', scope: project })
    expect(hits[1]?.record).toMatchObject({ id: 's1', scope: session })
    expect(hits[1]?.score).toBe(1)
    const body = JSON.parse(server.requests[0]?.body ?? '') as Record<string, unknown>
    expect(body.datasets).toEqual([scopeKey(project), scopeKey(session)])
    expect(body.search_type).toBe('GRAPH_COMPLETION')
  })

  it('only infers a scope when exactly one was requested and no dataset was returned', async () => {
    server = await startMockServer(() => ({ body: JSON.stringify([{ id: '1', text: 'one', score: 0.5 }]) }))
    const adapter = new CogneeRestAdapter({ config: config(server.url) })
    await expect(adapter.recall({ text: 'one', scopes: [project], limit: 5 })).resolves.toHaveLength(1)
    server.requests.length = 0
    await expect(adapter.recall({ text: 'one', scopes: [project, session], limit: 5 })).resolves.toHaveLength(0)
  })

  it('supports the results envelope and ignores malformed rows', async () => {
    server = await startMockServer(() => ({
      body: JSON.stringify({
        results: [
          { id: '1', content: 'from content', dataset: scopeKey(project), similarity: '0.8' },
          { id: '2', dataset: scopeKey(project) },
        ],
      }),
    }))
    const adapter = new CogneeRestAdapter({ config: config(server.url) })
    const hits = await adapter.recall({ text: 'content', scopes: [project], limit: 5 })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.record.text).toBe('from content')
    expect(hits[0]?.score).toBe(0.8)
  })

  it('surfaces 404/405/501 for forget and never deletes a dataset', async () => {
    for (const status of [404, 405, 501]) {
      server = await startMockServer(() => ({ status }))
      const adapter = new CogneeRestAdapter({ config: config(server.url) })
      await expect(adapter.forget({ id: 'mem-1', scope: project })).rejects.toMatchObject({
        code: 'UNSUPPORTED_OPERATION',
        operation: 'forget',
      })
      expect(server.requests).toHaveLength(1)
      expect(server.requests[0]?.method).toBe('DELETE')
      expect(server.requests[0]?.url).toBe(COGNEE_PATHS.delete)
      expect(server.requests.some((request) => request.url.includes('/datasets') && request.method === 'DELETE')).toBe(
        false,
      )
      await server.close()
      server = undefined
    }
  })

  it('reports a successful per-memory forget', async () => {
    server = await startMockServer(() => ({ body: JSON.stringify({ deleted: true }) }))
    const adapter = new CogneeRestAdapter({ config: config(server.url) })
    await expect(adapter.forget({ id: 'mem-1', scope: project })).resolves.toEqual({
      id: 'mem-1',
      scope: project,
      forgotten: true,
    })
    expect(server.requests[0]?.url).toBe(COGNEE_PATHS.delete)
  })

  it('reports status and health without leaking endpoint internals', async () => {
    server = await startMockServer((request) => {
      if (request.url === COGNEE_PATHS.datasets) return { body: JSON.stringify({ data: [{}, {}] }) }
      if (request.url === COGNEE_PATHS.health) return { body: '{"status":"ok"}' }
      return { status: 404 }
    })
    let now = 1_000
    const adapter = createCogneeRestAdapter({ config: config(server.url), now: () => (now += 5) })
    const status = await adapter.status()
    expect(status).toMatchObject({ transport: 'rest', reachable: true })
    expect(status.details?.datasetCount).toBe(2)
    const health = await adapter.health()
    expect(health).toMatchObject({ ok: true })
    expect(health.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('reports unreachable status instead of throwing', async () => {
    server = await startMockServer(() => ({ status: 500 }))
    const adapter = new CogneeRestAdapter({ config: config(server.url) })
    const status = await adapter.status()
    expect(status).toMatchObject({ transport: 'rest', reachable: false })
    expect(status.details?.errorCode).toBe('BACKEND')
    const health = await adapter.health()
    expect(health).toMatchObject({ ok: false, message: 'BACKEND' })
  })
})
