import { afterAll, describe, expect, it } from 'vitest'
import { CogneeRestAdapter } from '../../src/adapters/cognee-rest.js'
import { parseConfig } from '../../src/config/schema.js'
import { makeScopeRef, scopeKey } from '../../src/memory/scopes.js'

/**
 * Live integration test against a real Cognee instance.
 *
 * Skipped unless `COGNEE_API_KEY` is set. It writes to project-scoped datasets
 * whose names carry a per-run timestamp, verifies pipeline completion, recalls
 * the memory, proves scope isolation, deletes the record, and finally deletes
 * the two datasets it created. No mocks are involved.
 */
const apiKey = process.env.COGNEE_API_KEY?.trim()
const baseUrl = (process.env.COGNEE_BASE_URL ?? 'http://10.20.10.15:8000/api/v1').replace(/\/+$/, '')
const origin = new URL(baseUrl).origin
const stamp = Date.now()
const token = `LIVE-ADR-${stamp}`
const otherToken = `LIVE-OTHER-${stamp}`
const scopeA = makeScopeRef('project', `dsh/project/e2e-live-a-${stamp}`)
const scopeB = makeScopeRef('project', `dsh/project/e2e-live-b-${stamp}`)
const textA = `ADR-9001: ${token}: the deploy target is blue.`
const textB = `ADR-9002: ${otherToken}: the deploy target is green.`

const createdDatasetIds: string[] = []
const datasetIdByScope = new Map<string, string>()
const timings: Record<string, number> = {}

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      'X-Api-Key': apiKey ?? '',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  let body: unknown = text
  try {
    body = text === '' ? undefined : JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body }
}

function datasetIdFor(scope: ReturnType<typeof makeScopeRef>): string {
  const found = datasetIdByScope.get(scopeKey(scope))
  expect(found).toBeDefined()
  return found as string
}

describe.skipIf(apiKey === undefined || apiKey === '')('Cognee live integration', () => {
  const config = parseConfig({
    transport: 'rest',
    apiBaseUrl: baseUrl,
    authMode: 'api-key',
    apiTokenEnv: 'COGNEE_API_KEY',
    requestTimeoutMs: 180_000,
    maxRetries: 1,
    recall: { searchType: 'CHUNKS', maxRecallLatencyMs: 8_000 },
    ingestion: { timeoutMs: 180_000, pollMs: 500 },
  })
  const adapter = new CogneeRestAdapter({ config, env: process.env })

  afterAll(async () => {
    const ids = new Set(createdDatasetIds)
    for (const id of ids) {
      const result = await api(`/api/v1/datasets/${id}`, { method: 'DELETE' })
      expect([200, 404]).toContain(result.status)
    }
  })

  it('reaches the live instance over authenticated HTTP', async () => {
    const started = performance.now()
    const me = await api('/api/v1/users/me')
    timings.me = performance.now() - started
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({ is_active: true })
    const health = await api('/health')
    expect(health.status).toBe(200)
    expect(health.body).toMatchObject({ status: 'ready' })
    expect(JSON.stringify(health.body)).toContain('1.6.10')
  })

  it('remembers into project scope A and only returns after Cognee reports it searchable', async () => {
    const started = performance.now()
    const result = await adapter.remember({
      text: textA,
      scope: scopeA,
      tags: ['live-test'],
      provenance: {
        kind: 'tool_call',
        source: 'test:live',
        recordedAt: new Date().toISOString(),
      },
    })
    timings.rememberA = performance.now() - started
    expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(result.deduplicated).toBe(false)

    // Independent proof the adapter's completion gate matches the server.
    const datasets = await api('/api/v1/datasets')
    const datasetA = (datasets.body as Array<{ id: string; name: string }>).find(
      (dataset) => dataset.name === scopeKey(scopeA),
    )
    expect(datasetA).toBeDefined()
    const idA = datasetA?.id ?? ''
    createdDatasetIds.push(idA)
    datasetIdByScope.set(scopeKey(scopeA), idA)
    const memory = await api(`/api/v1/datasets/status/memory?dataset=${datasetA?.id}`)
    const state = (memory.body as Record<string, { searchable: boolean; state: string }>)[datasetA?.id ?? '']
    expect(state).toMatchObject({ searchable: true, state: 'ready' })
    const pipeline = await api(
      `/api/v1/datasets/status?dataset=${datasetA?.id}&pipeline=cognify_pipeline`,
    )
    expect((pipeline.body as Record<string, string>)[datasetA?.id ?? '']).toBe('DATASET_PROCESSING_COMPLETED')
    const processing = await api(`/api/v1/datasets/${datasetA?.id}/processing-status`)
    expect(processing.body).toMatchObject({ total: 1, completed: 1, pending: 0 })
  })

  it('remembers a second, independent project scope B', async () => {
    const started = performance.now()
    const result = await adapter.remember({
      text: textB,
      scope: scopeB,
      tags: ['live-test'],
      provenance: { kind: 'tool_call', source: 'test:live', recordedAt: new Date().toISOString() },
    })
    timings.rememberB = performance.now() - started
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/i)
    const datasets = await api('/api/v1/datasets')
    const datasetB = (datasets.body as Array<{ id: string; name: string }>).find(
      (dataset) => dataset.name === scopeKey(scopeB),
    )
    expect(datasetB).toBeDefined()
    const idB = datasetB?.id ?? ''
    createdDatasetIds.push(idB)
    datasetIdByScope.set(scopeKey(scopeB), idB)
  })

  it('recalls the stored decision with its content and dataset identity', async () => {
    const started = performance.now()
    const hits = await adapter.recall({ text: token, scopes: [scopeA], limit: 5 })
    timings.recallA = performance.now() - started
    expect(hits.length).toBeGreaterThan(0)
    const hit = hits.find((candidate) => candidate.record.text.includes(token))
    expect(hit).toBeDefined()
    expect(hit?.record.scope).toBe(scopeA)
    expect(hit?.score).toBeGreaterThan(0)
  })

  it('does not leak scope A content into scope B (dataset isolation)', async () => {
    const started = performance.now()
    const hitsB = await adapter.recall({ text: token, scopes: [scopeB], limit: 5 })
    timings.recallBForA = performance.now() - started
    expect(hitsB.some((hit) => hit.record.text.includes(token))).toBe(false)

    const hitsA = await adapter.recall({ text: otherToken, scopes: [scopeA], limit: 5 })
    expect(hitsA.some((hit) => hit.record.text.includes(otherToken))).toBe(false)

    const ownB = await adapter.recall({ text: otherToken, scopes: [scopeB], limit: 5 })
    expect(ownB.some((hit) => hit.record.text.includes(otherToken))).toBe(true)
  })

  it('forgets exactly one record and leaves the dataset searchable but without it', async () => {
    const hits = await adapter.recall({ text: token, scopes: [scopeA], limit: 5 })
    const target = hits.find((hit) => hit.record.text.includes(token))
    expect(target).toBeDefined()
    const id = target?.record.id ?? ''
    const datasetId = datasetIdFor(scopeA)
    const raw = await api(`/api/v1/datasets/${datasetId}/data`)
    const before = (raw.body as Array<{ id: string; contentHash: string }>).length
    expect(before).toBeGreaterThan(0)

    const started = performance.now()
    const result = await adapter.forget({ id, scope: scopeA })
    timings.forget = performance.now() - started
    expect(result.forgotten).toBe(true)

    const after = await api(`/api/v1/datasets/${datasetId}/data`)
    const remaining = after.body as Array<{ id: string }>
    expect(remaining.some((item) => item.id === id)).toBe(false)
    const recalls = await adapter.recall({ text: token, scopes: [scopeA], limit: 5 })
    expect(recalls.some((hit) => hit.record.text.includes(token))).toBe(false)
  })

  it('reports status and health against the live backend', async () => {
    const status = await adapter.status()
    expect(status.reachable).toBe(true)
    expect(status.details?.datasetCount).toBeGreaterThan(0)
    const health = await adapter.health()
    expect(health.ok).toBe(true)
    expect(health.message).toContain('1.6.10')
  })

  it('records the measured timings', () => {
    // Printed so a live run leaves its own evidence in the CI log.
    console.log(`[live] timings(ms) ${JSON.stringify(timings)}`)
    expect(Object.keys(timings).length).toBeGreaterThanOrEqual(5)
  })
})
