import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { parseConfig, type CogneeMemoryConfig } from '../src/config/schema.js'
import { CogneeRestAdapter } from '../src/adapters/cognee-rest.js'
import { makeScopeRef, scopeKey } from '../src/memory/scopes.js'
import {
  startMockServer,
  type MockServer,
  type MockServerRequest,
  type MockServerResponse,
} from './helpers/mock-server.js'

let server: MockServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex')
}

function json(body: unknown, status = 200) {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

function config(baseUrl: string, overrides: Record<string, unknown> = {}): CogneeMemoryConfig {
  return parseConfig({
    transport: 'rest',
    apiBaseUrl: `${baseUrl}/api/v1`,
    authMode: 'api-key',
    apiTokenEnv: 'COGNEE_API_KEY',
    requestTimeoutMs: 2_000,
    maxRetries: 0,
    retryBackoffMs: 0,
    ...overrides,
  })
}

const env = { COGNEE_API_KEY: 'test-key' } as NodeJS.ProcessEnv
const project = makeScopeRef('project', '/workspace/demo')
const other = makeScopeRef('project', '/workspace/other')
const USER_ID = '11111111-1111-4111-8111-111111111111'
const PROJECT_DATASET = '55555555-5555-4555-8555-555555555555'
const DATA_ID = '44444444-4444-4444-8444-444444444444'

interface FakeCognee {
  readonly handler: (request: MockServerRequest) => MockServerResponse | Promise<MockServerResponse>
  readonly datasets: Array<{ id: string; name: string; ownerId?: string }>
  readonly data: Map<string, Array<{ id: string; name: string; contentHash: string }>>
  memoryCalls: number
  readonly cognifyBodies: Array<Record<string, unknown>>
}

/** Stateful stand-in for the endpoints the adapter uses, with the observed shapes. */
function fakeCognee(options: { ownerId?: string; memoryUntilReady?: number } = {}): FakeCognee {
  const datasets: FakeCognee['datasets'] = []
  const data: FakeCognee['data'] = new Map()
  let created = 0
  const state: FakeCognee = {
    datasets,
    data,
    memoryCalls: 0,
    cognifyBodies: [],
    handler(request) {
      const url = new URL(request.url ?? '/', 'http://mock')
      const path = url.pathname
      if (path === '/api/v1/users/me') return json({ id: USER_ID, email: 'agent@cognee.agent' })
      if (path === '/api/v1/datasets' && request.method === 'GET') {
        return json(datasets.map((dataset) => ({ ...dataset, createdAt: '2026-11-21T00:00:00Z', updatedAt: null })))
      }
      if (path === '/api/v1/datasets' && request.method === 'POST') {
        const body = JSON.parse(request.body) as { name: string }
        created += 1
        const dataset = {
          id: `2222222${created}-2222-4222-8222-222222222222`.slice(0, 36),
          name: body.name,
          ownerId: options.ownerId ?? USER_ID,
        }
        datasets.push(dataset)
        return json(dataset)
      }
      const dataMatch = /^\/api\/v1\/datasets\/([^/]+)\/data$/.exec(path)
      if (dataMatch?.[1] !== undefined) {
        return json(data.get(dataMatch[1]) ?? [])
      }
      if (path === '/api/v1/datasets/status/memory') {
        state.memoryCalls += 1
        const datasetId = url.searchParams.get('dataset') ?? ''
        const ready = state.memoryCalls > (options.memoryUntilReady ?? 1)
        return json({
          [datasetId]: {
            state: ready ? 'ready' : 'staged',
            search_level: ready ? 'graph' : 'none',
            searchable: ready,
            graph_ready: ready,
            message: ready ? 'Memory is fully built.' : 'Run cognify().',
            indexing_status: 'DATASET_PROCESSING_COMPLETED',
            cognify_status: ready ? 'DATASET_PROCESSING_COMPLETED' : null,
            error_class: null,
            error_message: null,
          },
        })
      }
      if (path === '/api/v1/datasets/status') {
        const datasetId = url.searchParams.get('dataset') ?? ''
        return json({ [datasetId]: 'DATASET_PROCESSING_COMPLETED' })
      }
      if (path === '/api/v1/remember' && request.method === 'POST') {
        const datasetId = /name="datasetId"\r\n\r\n([^\r]+)/.exec(request.body)?.[1] ?? ''
        const raw = /name="raw_data"\r\n\r\n([\s\S]*?)\r\n--/.exec(request.body)?.[1] ?? ''
        const id = `3333333${(data.get(datasetId)?.length ?? 0) + 1}-3333-4333-8333-333333333333`.slice(0, 36)
        const items = data.get(datasetId) ?? []
        items.push({ id, name: 'text_1', contentHash: 'ignored' })
        data.set(datasetId, items)
        return json({
          status: 'completed',
          dataset_name: datasets.find((dataset) => dataset.id === datasetId)?.name,
          dataset_id: datasetId,
          pipeline_run_id: 'run-1',
          items_processed: 1,
          elapsed_seconds: 0.1,
          items: [{ id }],
          raw_length: raw.length,
        })
      }
      if (path === '/api/v1/add' && request.method === 'POST') {
        const datasetId = /name="datasetId"\r\n\r\n([^\r]+)/.exec(request.body)?.[1] ?? ''
        const texts = [...request.body.matchAll(/name="raw_data"\r\n\r\n([\s\S]*?)\r\n--/g)].map(
          (match) => match[1] ?? '',
        )
        const items = data.get(datasetId) ?? []
        for (const text of texts) {
          const sequence = items.length + 1
          const id = `3333333${sequence}-3333-4333-8333-333333333333`.slice(0, 36)
          // The live instance stores md5(raw text) as contentHash.
          items.push({ id, name: `text_${sequence}`, contentHash: md5(text) })
        }
        data.set(datasetId, items)
        // Observed shape: one entry per submitted document, naming it text_<md5>.
        return json({
          status: 'PipelineRunCompleted',
          dataset_id: datasetId,
          data_ingestion_info: texts.map((text, index) => {
            const item = items[items.length - texts.length + index]
            return {
              run_info: { status: 'PipelineRunCompleted', id: item?.id },
              data_id: item?.id,
              // Deliberately NOT md5(text): the live instance's name is not the
              // raw-text hash for multi-line documents, so the adapter must not
              // depend on it.
              data_name: `text_${md5(`${text.length}:${index}`)}`,
            }
          }),
          data_ids: items.slice(-texts.length).map((item) => item.id),
        })
      }
      if (path === '/api/v1/cognify' && request.method === 'POST') {
        const body = JSON.parse(request.body) as { datasetIds?: string[] }
        const datasetId = body.datasetIds?.[0] ?? ''
        state.cognifyBodies.push(body)
        return json({
          [datasetId]: {
            status: 'PipelineRunCompleted',
            pipeline_run_id: 'run-1',
            dataset_id: datasetId,
            data_ids: (data.get(datasetId) ?? []).map((item) => item.id),
          },
        })
      }
      if (path === '/api/v1/search' && request.method === 'POST') {
        const body = JSON.parse(request.body) as { datasetIds?: string[]; query: string; topK?: number }
        return json([
          {
            dataset_id: body.datasetIds?.[0],
            dataset_name: scopeKey(project),
            dataset_tenant_id: null,
            search_result: [
              {
                id: 'chunk-1',
                text: 'the deploy target is blue',
                document_id: DATA_ID,
                document_name: 'text_1',
                created_at: 1_795_307_390_969,
                // CHUNKS rows carry a vector distance (0 = identical); the
                // adapter converts it to the plugin's similarity contract.
                score: 0.13,
                belongs_to_set: ['ops'],
              },
            ],
          },
          {
            dataset_id: '99999999-9999-4999-8999-999999999999',
            dataset_name: 'foreign_dataset',
            search_result: [{ id: 'x', text: 'foreign memory', document_id: 'x', score: 1 }],
          },
        ])
      }
      if (path === '/api/v1/forget' && request.method === 'POST') {
        const body = JSON.parse(request.body) as { datasetId: string; dataId: string }
        return json({
          status: 'success',
          dataset_id: body.datasetId,
          data_id: body.dataId,
          data_record_found: true,
          deleted_nodes: 2,
          deleted_edges: 1,
          data_remaining: false,
          dataset_deleted: false,
        })
      }
      if (path === '/health') return json({ status: 'ready', health: 'healthy', version: '1.6.10-local' })
      return json({ detail: 'not found' }, 404)
    },
  }
  return state
}

describe('CogneeRestAdapter (verified live contract)', () => {
  it('creates the dataset first and writes with datasetId, never datasetName', async () => {
    const fake = fakeCognee()
    server = await startMockServer(fake.handler)
    const adapter = new CogneeRestAdapter({ config: config(server.url), env })
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
    expect(result.id).toBe('33333331-3333-4333-8333-333333333333')
    expect(result.scope).toBe(project)
    expect(result.deduplicated).toBe(false)
    const calls = server.requests.map((request) => `${request.method} ${request.url}`)
    expect(calls[0]).toBe('GET /api/v1/datasets')
    expect(calls[1]).toBe('POST /api/v1/datasets')
    const write = server.requests.find((request) => request.url === '/api/v1/remember')
    expect(write?.body).toContain('name="datasetId"')
    expect(write?.body).toContain(fake.datasets[0]?.id ?? 'missing')
    expect(write?.body).not.toContain('name="datasetName"')
    expect(write?.headers['x-api-key']).toBe('test-key')
    expect(write?.headers['content-type']).toContain('multipart/form-data')
  })

  it('refuses a same-named dataset owned by another Cognee user (quirk 2 guard)', async () => {
    const fake = fakeCognee({ ownerId: '99999999-9999-4999-8999-999999999999' })
    fake.datasets.push({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: scopeKey(project),
      ownerId: '99999999-9999-4999-8999-999999999999',
    })
    server = await startMockServer(fake.handler)
    const adapter = new CogneeRestAdapter({ config: config(server.url), env })
    await expect(
      adapter.remember({
        text: 'should not be written',
        scope: project,
        provenance: { kind: 'tool_call', source: 'test', recordedAt: '2026-01-01T00:00:00.000Z' },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(server.requests.some((request) => request.url === '/api/v1/remember')).toBe(false)
  })

  it('derives completion from status/memory + pipeline status, not from the 200', async () => {
    const fake = fakeCognee({ memoryUntilReady: 3 })
    server = await startMockServer(fake.handler)
    let clock = 1_000
    const adapter = new CogneeRestAdapter({
      config: config(server.url, { ingestion: { timeoutMs: 10_000, pollMs: 500 } }),
      env,
      now: () => (clock += 10),
      sleep: async () => {
        clock += 500
      },
    })
    const result = await adapter.remember({
      text: 'pipeline-gated memory',
      scope: project,
      provenance: { kind: 'tool_call', source: 'test', recordedAt: '2026-01-01T00:00:00.000Z' },
    })
    expect(result.id).toMatch(/^3333/)
    // staged, staged, staged, ready => 4 polls; a 200-only adapter would poll once.
    expect(fake.memoryCalls).toBe(4)
    const statusCalls = server.requests.filter((request) => request.url.startsWith('/api/v1/datasets/status?'))
    expect(statusCalls.length).toBe(1)
    expect(statusCalls[0]?.url).toContain('pipeline=cognify_pipeline')
  })

  it('fails the write when ingestion never becomes searchable', async () => {
    const fake = fakeCognee({ memoryUntilReady: 1_000 })
    server = await startMockServer(fake.handler)
    let clock = 1_000
    const adapter = new CogneeRestAdapter({
      config: config(server.url, { ingestion: { timeoutMs: 1_000, pollMs: 100 } }),
      env,
      now: () => (clock += 120),
      sleep: async () => {},
    })
    await expect(
      adapter.remember({
        text: 'never ready',
        scope: project,
        provenance: { kind: 'tool_call', source: 'test', recordedAt: '2026-01-01T00:00:00.000Z' },
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('parses the verified /search group shape and drops foreign datasets', async () => {
    const fake = fakeCognee()
    fake.datasets.push({ id: PROJECT_DATASET, name: scopeKey(project), ownerId: USER_ID })
    server = await startMockServer(fake.handler)
    const adapter = new CogneeRestAdapter({ config: config(server.url), env })
    const hits = await adapter.recall({ text: 'deploy target', scopes: [project, other], limit: 5 })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.record).toMatchObject({
      id: DATA_ID,
      text: 'the deploy target is blue',
      scope: project,
      createdAt: new Date(1_795_307_390_969).toISOString(),
      tags: ['ops'],
      metadata: { datasetId: PROJECT_DATASET, datasetName: scopeKey(project), tags: ['ops'] },
    })
    expect(hits[0]?.score).toBeCloseTo(0.87)
    expect(hits[0]?.record.text).toBe('the deploy target is blue')
    const search = server.requests.find((request) => request.url === '/api/v1/search')
    expect(JSON.parse(search?.body ?? '{}')).toMatchObject({
      query: 'deploy target',
      searchType: 'CHUNKS',
      datasetIds: [PROJECT_DATASET],
      topK: 5,
    })
  })

  it('converts CHUNKS distance scores to similarity and keeps the closest first', async () => {
    // Observed Cognee 1.6.10-local: an exact match scored 0.0486, unrelated
    // memories 0.39–0.49, returned in ascending distance. Left raw, the
    // descending sort in RecallService would rank the least relevant first.
    const fake = fakeCognee()
    fake.datasets.push({ id: PROJECT_DATASET, name: scopeKey(project), ownerId: USER_ID })
    server = await startMockServer(async (request) => {
      const url = new URL(request.url ?? '/', 'http://mock')
      if (url.pathname === '/api/v1/search') {
        return json([
          {
            dataset_id: PROJECT_DATASET,
            dataset_name: scopeKey(project),
            dataset_tenant_id: null,
            search_result: [
              {
                id: 'chunk-close',
                text: 'the maintenance window is 03:00-04:00',
                document_id: '66666666-6666-4666-8666-666666666666',
                score: 0.0486,
              },
              {
                id: 'chunk-far',
                text: 'an unrelated project convention',
                document_id: '77777777-7777-4777-8777-777777777777',
                score: 0.46,
              },
            ],
          },
        ])
      }
      return fake.handler(request)
    })
    const adapter = new CogneeRestAdapter({ config: config(server.url), env })
    const hits = await adapter.recall({ text: 'maintenance window', scopes: [project], limit: 5 })
    expect(hits.map((hit) => hit.record.text)).toEqual([
      'the maintenance window is 03:00-04:00',
      'an unrelated project convention',
    ])
    expect(hits[0]?.score).toBeCloseTo(0.9514)
    expect(hits[1]?.score).toBeCloseTo(0.54)
  })

  it('degrades recall quietly when the latency budget expires (open mode)', async () => {
    const fake = fakeCognee()
    fake.datasets.push({ id: PROJECT_DATASET, name: scopeKey(project), ownerId: USER_ID })
    server = await startMockServer(async (request) => {
      const spec = (await fake.handler(request)) as { body?: string; status?: number }
      return { ...spec, delayMs: 600 }
    })
    const adapter = new CogneeRestAdapter({
      config: config(server.url, { recall: { searchType: 'GRAPH_COMPLETION', maxRecallLatencyMs: 150 } }),
      env,
    })
    const hits = await adapter.recall({ text: 'deploy', scopes: [project], limit: 5 })
    expect(hits).toEqual([])
  })

  it('surfaces the timeout when failure mode is closed', async () => {
    const fake = fakeCognee()
    fake.datasets.push({ id: PROJECT_DATASET, name: scopeKey(project), ownerId: USER_ID })
    server = await startMockServer(async (request) => {
      const spec = (await fake.handler(request)) as { body?: string; status?: number }
      return { ...spec, delayMs: 600 }
    })
    const adapter = new CogneeRestAdapter({
      config: config(server.url, {
        failureMode: 'closed',
        recall: { searchType: 'GRAPH_COMPLETION', maxRecallLatencyMs: 150 },
      }),
      env,
    })
    await expect(adapter.recall({ text: 'deploy', scopes: [project], limit: 5 })).rejects.toMatchObject({
      code: 'TIMEOUT',
    })
  })

  it('forgets one data record by datasetId + dataId, never a dataset', async () => {
    const fake = fakeCognee()
    fake.datasets.push({ id: PROJECT_DATASET, name: scopeKey(project), ownerId: USER_ID })
    server = await startMockServer(fake.handler)
    const adapter = new CogneeRestAdapter({ config: config(server.url), env })
    await expect(adapter.forget({ id: DATA_ID, scope: project })).resolves.toEqual({
      id: DATA_ID,
      scope: project,
      forgotten: true,
    })
    const forget = server.requests.find((request) => request.url === '/api/v1/forget')
    expect(JSON.parse(forget?.body ?? '{}')).toEqual({ datasetId: PROJECT_DATASET, dataId: DATA_ID })
    expect(server.requests.some((request) => request.method === 'DELETE')).toBe(false)
  })

  it('does not send a synthetic (non-UUID) id to the backend', async () => {
    const fake = fakeCognee()
    fake.datasets.push({ id: PROJECT_DATASET, name: scopeKey(project), ownerId: USER_ID })
    server = await startMockServer(fake.handler)
    const adapter = new CogneeRestAdapter({ config: config(server.url), env })
    await expect(adapter.forget({ id: 'graph-abc', scope: project })).resolves.toMatchObject({
      forgotten: false,
    })
    expect(server.requests.some((request) => request.url === '/api/v1/forget')).toBe(false)
  })

  it('reports a read-only dataset inventory with record counts', async () => {
    const fake = fakeCognee()
    fake.datasets.push({ id: PROJECT_DATASET, name: scopeKey(project), ownerId: USER_ID })
    fake.data.set(PROJECT_DATASET, [
      { id: DATA_ID, name: 'text_1', contentHash: 'hash-1' },
    ])
    server = await startMockServer(fake.handler)
    const adapter = new CogneeRestAdapter({ config: config(server.url), env })
    const inventory = await adapter.inventory()
    expect(inventory.datasets).toEqual([
      { id: PROJECT_DATASET, name: scopeKey(project), dataCount: 1 },
    ])
    expect(inventory.totalRecords).toBe(1)
    expect(inventory.checkedAt).toMatch(/Z$/)
    expect(JSON.stringify(inventory)).not.toContain('test-key')
    expect(JSON.stringify(inventory)).not.toContain('the deploy target is blue')
  })

  it('resolves a dataset UUID by exact name beyond the inventory page', async () => {
    const fake = fakeCognee()
    for (let index = 0; index < 12; index += 1) {
      fake.datasets.push({ id: `0000000${index}-0000-4000-8000-00000000000${index}`, name: `dsh-project-filler-${index}`, ownerId: USER_ID })
    }
    fake.datasets.push({ id: PROJECT_DATASET, name: scopeKey(project), ownerId: USER_ID })
    server = await startMockServer(fake.handler)
    const adapter = new CogneeRestAdapter({ config: config(server.url), env })
    await expect(adapter.lookupDataset(scopeKey(project))).resolves.toEqual({
      id: PROJECT_DATASET,
      name: scopeKey(project),
    })
    await expect(adapter.lookupDataset('no-such-dataset')).resolves.toBeUndefined()
    await expect(adapter.lookupDataset('  ')).resolves.toBeUndefined()
  })

  it('reports status and health (origin-relative /health) without leaking the key', async () => {
    const fake = fakeCognee()
    fake.datasets.push({ id: PROJECT_DATASET, name: scopeKey(project), ownerId: USER_ID })
    server = await startMockServer(fake.handler)
    let now = 1_000
    const adapter = new CogneeRestAdapter({ config: config(server.url), env, now: () => (now += 5) })
    const status = await adapter.status()
    expect(status).toMatchObject({ transport: 'rest', reachable: true })
    expect(status.details?.datasetCount).toBe(1)
    expect(JSON.stringify(status)).not.toContain('test-key')
    const health = await adapter.health()
    expect(health).toMatchObject({ ok: true, message: 'cognee 1.6.10-local' })
    expect(server.requests.some((request) => request.url === '/health')).toBe(true)
  })

  it('reports unreachable status instead of throwing', async () => {
    server = await startMockServer(() => ({ status: 500 }))
    const adapter = new CogneeRestAdapter({ config: config(server.url), env })
    const status = await adapter.status()
    expect(status).toMatchObject({ transport: 'rest', reachable: false })
    expect(status.details?.errorCode).toBe('BACKEND')
    const health = await adapter.health()
    expect(health).toMatchObject({ ok: false, message: 'BACKEND' })
  })
})

describe('CogneeRestAdapter.rememberBatch (batched ingest)', () => {
  const inputs = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      text: `summary ${index}: the deploy window moved to Friday.`,
      scope: project,
      provenance: { kind: 'import' as const, source: 'segment-summary', recordedAt: '2026-01-01T00:00:00.000Z' },
    }))

  it('sends ONE add with every document and ONE cognify, mapping ids by content hash', async () => {
    const fake = fakeCognee()
    server = await startMockServer(fake.handler)
    const adapter = new CogneeRestAdapter({ config: config(server.url), env })
    const inputs10 = inputs(10)
    const results = await adapter.rememberBatch(inputs10)

    const adds = server.requests.filter((request) => request.url === '/api/v1/add')
    const cognifies = server.requests.filter((request) => request.url === '/api/v1/cognify')
    expect(adds).toHaveLength(1)
    expect(cognifies).toHaveLength(1)
    expect([...(adds[0]?.body ?? '').matchAll(/name="raw_data"/g)]).toHaveLength(10)
    expect(server.requests.some((request) => request.url === '/api/v1/remember')).toBe(false)

    expect(results).toHaveLength(10)
    expect(results.every((result) => result.ok)).toBe(true)
    const ids = new Set(results.map((result) => (result.ok ? result.id : 'missing')))
    expect(ids.size).toBe(10)
    for (const result of results) {
      if (result.ok) expect(result.deduplicated).toBe(false)
    }
  })

  it('passes the configured cognify parallelism knobs through the one cognify call', async () => {
    const fake = fakeCognee()
    server = await startMockServer(fake.handler)
    const adapter = new CogneeRestAdapter({
      config: config(server.url, { ingestion: { queue: { cognify: { dataPerBatch: 5, chunksPerBatch: 36 } } } }),
      env,
    })
    await adapter.rememberBatch(inputs(3))
    expect(fake.cognifyBodies).toHaveLength(1)
    expect(fake.cognifyBodies[0]).toMatchObject({ dataPerBatch: 5, chunksPerBatch: 36 })
    expect(fake.cognifyBodies[0]?.dataPerBatch).toBe(5)
  })

  it('degrades to per-item remembers when a batch mixes scopes', async () => {
    const fake = fakeCognee()
    server = await startMockServer(fake.handler)
    const adapter = new CogneeRestAdapter({ config: config(server.url), env })
    const mixed = [
      { ...inputs(1)[0]!, scope: project },
      { ...inputs(1)[0]!, text: 'other scope summary', scope: other },
    ]
    const results = await adapter.rememberBatch(mixed)
    expect(results).toHaveLength(2)
    expect(results.every((result) => result.ok)).toBe(true)
    expect(server.requests.filter((request) => request.url === '/api/v1/remember')).toHaveLength(2)
    expect(server.requests.filter((request) => request.url === '/api/v1/add')).toHaveLength(0)
  })
})

describe('CogneeRestAdapter.rememberBatch id mapping', () => {
  it('maps ids from the /add response even when the data listing lags behind', async () => {
    const fake = fakeCognee()
    const inner = fake.handler
    // Simulate the live instance's eventual consistency: the listing misses the
    // rows that were just added, which is what silently broke the batch in the
    // 1.0.8 production drain (23 of 25 unmapped).
    const frozenList = new Map<string, Array<{ id: string; name: string; contentHash: string }>>()
    const lagging = {
      ...fake,
      handler: (request: MockServerRequest) => {
        const url = new URL(request.url ?? '/', 'http://mock')
        const match = /^\/api\/v1\/datasets\/([^/]+)\/data$/.exec(url.pathname)
        if (match?.[1] !== undefined && request.method === 'GET') {
          if (!frozenList.has(match[1])) frozenList.set(match[1], [...(fake.data.get(match[1]) ?? [])])
          return json(frozenList.get(match[1]) ?? [])
        }
        return inner(request)
      },
    }
    server = await startMockServer(lagging.handler)
    const adapter = new CogneeRestAdapter({ config: config(server.url), env })
    const results = await adapter.rememberBatch(
      Array.from({ length: 5 }, (_, index) => ({
        text: `lagging summary ${index}`,
        scope: project,
        provenance: { kind: 'import' as const, source: 'segment-summary', recordedAt: '2026-01-01T00:00:00.000Z' },
      })),
    )
    expect(results).toHaveLength(5)
    expect(results.every((result) => result.ok)).toBe(true)
    expect(new Set(results.map((result) => (result.ok ? result.id : 'x'))).size).toBe(5)
  })
})
