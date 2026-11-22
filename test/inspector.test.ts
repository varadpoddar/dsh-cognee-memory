import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config/schema.js'
import { MEMORY_INSPECTION_STATES, buildInspection } from '../src/settings/inspect.js'
import { SettingsStore } from '../src/settings/store.js'
import { makeScopeRef, scopeKey } from '../src/memory/scopes.js'
import { FIXED_NOW } from './helpers/fake-coordinator.js'

const PROJECT = makeScopeRef('project', '/workspace/demo')
const USER = makeScopeRef('user', 'principal-1')

function store(overrides: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) {
  const base = parseConfig({
    scopeDefaults: { projectId: '/workspace/demo' },
    identity: { principalId: 'principal-1' },
    autoRecall: true,
    autoWrite: false,
    ...overrides,
  })
  return new SettingsStore({ filePath: `${process.cwd()}/does-not-exist/settings.json`, baseConfig: base, env })
}

function metrics(counters: Record<string, number> = {}, samples: Record<string, unknown> = {}) {
  return {
    snapshot: () => ({
      counters,
      samples: {
        'recall.latencyMs': { count: 0, p50: 0, p95: 0, last: 0 },
        'prefetch.latencyMs': { count: 0, p50: 0, p95: 0, last: 0 },
        'context.usage': { count: 0, p50: 0, p95: 0, last: 0 },
        ...samples,
      },
    }),
  }
}

function coordinator() {
  return {
    async resolveIdentity() {
      return { principalId: 'principal-1', projectId: '/workspace/demo' }
    },
    async policyFor() {
      return { readableScopes: [PROJECT, USER] }
    },
  }
}

const extraction = {
  async status() {
    return {
      queue: { queued: 1, ingested: 2, failed: 1, forgotten: 0, total: 4 },
      outbox: {
        pending: 1,
        processing: 1,
        complete: 1,
        failed: 1,
        total: 4,
        operations: [
          {
            operationId: 'op-pending',
            idempotencyKey: 'cand-1',
            operation: 'remember' as const,
            dataset: 'dsh-project-workspace-demo',
            state: 'pending' as const,
            attempts: 0,
            updatedAt: FIXED_NOW,
            preview: 'pending memory',
          },
          {
            operationId: 'op-ingesting',
            idempotencyKey: 'cand-2',
            operation: 'remember' as const,
            dataset: 'dsh-project-workspace-demo',
            state: 'processing' as const,
            attempts: 1,
            updatedAt: FIXED_NOW,
            preview: 'ingesting memory',
          },
          {
            operationId: 'op-done',
            idempotencyKey: 'cand-3',
            operation: 'remember' as const,
            dataset: 'dsh-project-workspace-demo',
            state: 'complete' as const,
            attempts: 1,
            dataRef: 'cognee:dsh-project-workspace-demo#mem-3',
            updatedAt: FIXED_NOW,
            preview: 'indexed memory',
          },
          {
            operationId: 'op-failed',
            idempotencyKey: 'cand-4',
            operation: 'remember' as const,
            dataset: 'dsh-project-workspace-demo',
            state: 'failed' as const,
            attempts: 3,
            reason: 'BACKEND',
            updatedAt: FIXED_NOW,
            preview: 'failed memory',
          },
        ],
      },
      pendingCandidates: [
        {
          id: 'mem-candidate',
          idempotencyKey: 'cand-new',
          operation: 'remember',
          semanticKey: 'deploy-target',
          preview: 'candidate memory',
        },
      ],
    }
  },
}

const inventory = {
  async inventory() {
    return {
      datasets: [
        { id: 'dataset-1', name: 'dsh-project-workspace-demo', dataCount: 3 },
        { id: 'dataset-2', name: 'dsh-user-principal-1', dataCount: 2 },
      ],
      totalRecords: 5,
      checkedAt: FIXED_NOW,
    }
  },
}

async function inspect(overrides: Parameters<typeof buildInspection>[0] extends never ? never : Record<string, unknown> = {}) {
  return buildInspection({
    store: store(),
    metrics: metrics(),
    coordinator: coordinator(),
    identity: { principalId: 'principal-1', sessionId: 'session-1' },
    extraction,
    inventory: () => inventory.inventory(),
    now: () => Date.parse(FIXED_NOW),
    ...overrides,
  } as never)
}

describe('buildInspection', () => {
  it('reports toggles, principal, project, and readable scopes', async () => {
    const result = await inspect()
    expect(result.toggles).toMatchObject({ autoRecall: true, autoWrite: false })
    expect(result.toggles.sources.autoRecall).toBe('profile')
    expect(result.scopes.principal).toBe('principal-1')
    expect(result.scopes.project).toBe(scopeKey(PROJECT))
    expect(result.scopes.readable).toEqual([
      { scope: 'project', id: PROJECT.id, dataset: scopeKey(PROJECT) },
      { scope: 'user', id: USER.id, dataset: scopeKey(USER) },
    ])
  })

  it('reports an unknown principal when identity cannot be resolved', async () => {
    const result = await inspect({
      coordinator: {
        async resolveIdentity() {
          throw new Error('probe failed')
        },
      },
    })
    expect(result.scopes.principal).toBe('unknown')
    expect(result.scopes.readable).toEqual([])
  })

  it('reports candidate queue and ingestion counts', async () => {
    const result = await inspect()
    expect(result.candidates).toMatchObject({
      queued: 1,
      ingested: 2,
      failed: 1,
      total: 4,
    })
    expect(result.ingestion).toEqual({ succeeded: 0, failed: 0 })
  })

  it('uses outbox counters for ingestion once they exist', async () => {
    const result = await inspect({
      metrics: metrics({ 'outbox.completed': 7, 'outbox.failed': 2 }),
    })
    expect(result.ingestion).toEqual({ succeeded: 7, failed: 2 })
  })

  it('computes the first-turn recall hit rate, including the empty case', async () => {
    const empty = await inspect()
    expect(empty.recall.firstTurn).toEqual({ attempts: 0, hits: 0, misses: 0, hitRate: 0 })
    const result = await inspect({
      metrics: metrics({ 'recall.firstTurnHits': 3, 'recall.firstTurnMisses': 1 }),
    })
    expect(result.recall.firstTurn).toEqual({ attempts: 4, hits: 3, misses: 1, hitRate: 0.75 })
  })

  it('forwards latency percentiles and context token usage', async () => {
    const result = await inspect({
      metrics: metrics(
        { 'memory.context.consumed': 2_400 },
        {
          'recall.latencyMs': { count: 12, p50: 41, p95: 180, last: 55 },
          'prefetch.latencyMs': { count: 4, p50: 60, p95: 140, last: 60 },
          'context.usage': { count: 4, p50: 210, p95: 640, last: 512 },
        },
      ),
    })
    expect(result.recall.latency.recall).toEqual({ count: 12, p50: 41, p95: 180 })
    expect(result.recall.latency.prefetch).toEqual({ count: 4, p50: 60, p95: 140 })
    expect(result.recall.contextTokens).toEqual({ last: 512, p95: 640, total: 2_400 })
  })

  it('reports the memory count and datasets from the backend inventory', async () => {
    const result = await inspect()
    expect(result.memory.count).toBe(5)
    expect(result.memory.datasets).toHaveLength(2)
    expect(result.memory.checkedAt).toBe(FIXED_NOW)
  })

  it('degrades cleanly when the inventory is unavailable', async () => {
    const result = await inspect({
      inventory: async () => {
        throw new Error('offline')
      },
    })
    expect(result.memory.count).toBeNull()
    expect(result.memory.datasets).toEqual([])
    expect(result.memory.degraded).toBe('inventory unavailable')
    expect(result.warnings.join(' ')).toContain('inventory')
  })

  it('maps evidenced memory states across the full vocabulary', async () => {
    const result = await inspect({
      verification: { has: (id: string) => id === 'mem-3' },
    })
    const byState = new Map(result.memories.map((row) => [row.state, row]))
    expect(byState.get('candidate')?.preview).toBe('candidate memory')
    expect(byState.get('queued')?.preview).toBe('pending memory')
    expect(byState.get('ingesting')?.preview).toBe('ingesting memory')
    expect(byState.get('recall-verified')?.preview).toBe('indexed memory')
    expect(byState.get('failed')?.reason).toBe('BACKEND')
    for (const state of MEMORY_INSPECTION_STATES) {
      expect(result.stateCounts[state]).toBeGreaterThanOrEqual(0)
    }
    expect(Object.keys(result.stateCounts).sort()).toEqual([...MEMORY_INSPECTION_STATES].sort())
  })

  it('reports indexed but not recall-verified when no recall returned the record', async () => {
    const result = await inspect()
    expect(result.memories.some((row) => row.state === 'recall-verified')).toBe(false)
    expect(result.memories.some((row) => row.state === 'indexed')).toBe(true)
  })

  it('never includes credential material in the serialized snapshot', async () => {
    const secretStore = store({}, {
      COGNEE_API_KEY: 'sk-live-abcdefghijklmnopqrstuvwxyz',
      COGNEE_MEMORY_SETTINGS_TOKEN: 'operator-token',
    })
    const result = await inspect({ store: secretStore })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toMatch(/sk-live|operator-token|password|api[_-]?key/i)
  })
})
