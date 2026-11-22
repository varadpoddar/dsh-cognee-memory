import { describe, expect, it } from 'vitest'
import { MemoryError } from '../src/errors.js'
import { RecallService } from '../src/memory/recall.js'
import { makeScopeRef } from '../src/memory/scopes.js'
import { Metrics } from '../src/telemetry/metrics.js'
import type { MemoryAdapter, RecallHit } from '../src/types.js'
import { FIXED_NOW, PROJECT_ID, SESSION_SCOPE, identity, record } from './helpers/fake-coordinator.js'
import { parseConfig } from '../src/config/schema.js'

const config = parseConfig({ scopeDefaults: { projectId: PROJECT_ID } })
const project = makeScopeRef('project', PROJECT_ID)
const foreign = makeScopeRef('session', 'someone-else')

function recallService(recall: MemoryAdapter['recall'], overrides: Record<string, unknown> = {}) {
  const adapter: MemoryAdapter = {
    async remember() {
      throw new Error('not used')
    },
    recall,
    async forget() {
      throw new Error('not used')
    },
    async status() {
      return { transport: 'rest', reachable: true, checkedAt: FIXED_NOW }
    },
    async health() {
      return { ok: true }
    },
  }
  const metrics = new Metrics()
  const provenance = {
    calls: [] as Array<{ ids: string[]; searchType: string | undefined }>,
    recordRecall(
      hits: readonly RecallHit[],
      context: { readonly identity?: { readonly principalId?: string }; readonly searchType?: string },
    ) {
      this.calls.push({ ids: hits.map((hit) => hit.record.id), searchType: context.searchType })
    },
  }
  return {
    metrics,
    provenance,
    service: new RecallService(
      { adapter, config: parseConfig({ ...config, ...overrides }), metrics },
      { cwd: PROJECT_ID, provenanceIndex: provenance },
    ),
  }
}

function hits(...items: RecallHit[]): MemoryAdapter['recall'] {
  return async () => items
}

describe('RecallService', () => {
  it('drops backend rows outside the caller scopes', async () => {
    const { service } = recallService(
      hits(record('1', 'mine'), record('2', 'foreign', foreign), record('3', '', project)),
    )
    const result = await service.recall({ text: 'query', identity: identity() })
    expect(result.map((hit) => hit.record.id)).toEqual(['1'])
  })

  it('deduplicates repeated ids and clamps/sorts scores', async () => {
    const { service } = recallService(
      hits(
        { ...record('1', 'low'), score: -1 },
        { ...record('2', 'high'), score: 9 },
        { ...record('2', 'high duplicate'), score: 9 },
      ),
    )
    const result = await service.recall({ text: 'query', identity: identity() })
    expect(result.map((hit) => hit.record.id)).toEqual(['2', '1'])
    expect(result.map((hit) => hit.score)).toEqual([1, 0])
  })

  it('respects limit and minScore', async () => {
    const { service } = recallService(
      hits(
        { ...record('1', 'one'), score: 0.9 },
        { ...record('2', 'two'), score: 0.5 },
        { ...record('3', 'three'), score: 0.2 },
      ),
    )
    const limited = await service.recall({ text: 'query', identity: identity(), limit: 2 })
    expect(limited.map((hit) => hit.record.id)).toEqual(['1', '2'])
    const scored = await service.recall({ text: 'query', identity: identity(), minScore: 0.4 })
    expect(scored.map((hit) => hit.record.id)).toEqual(['1', '2'])
  })

  it('queries every readable caller scope', async () => {
    let seen: readonly { scope: string }[] = []
    const { service } = recallService(async (query) => {
      seen = query.scopes
      return []
    })
    await service.recall({ text: 'query', identity: identity() })
    expect(seen.map((scope) => scope.scope)).toEqual(['agent', 'project'])
  })

  it('rejects empty queries and disabled memory', async () => {
    const { service } = recallService(hits())
    await expect(service.recall({ text: '   ', identity: identity() })).rejects.toMatchObject({
      code: 'VALIDATION',
    })
    const disabled = recallService(hits(), { enabled: false })
    await expect(
      disabled.service.recall({ text: 'query', identity: identity() }),
    ).rejects.toMatchObject({ code: 'DISABLED' })
  })

  it('records failures and degrades safely in open mode', async () => {
    const { service, metrics } = recallService(async () => {
      throw new MemoryError('UNAVAILABLE', 'offline', { retryable: true })
    })
    await expect(service.recall({ text: 'q', identity: identity() })).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
    expect(metrics.snapshot().counters['recall.failures']).toBe(1)
    await expect(service.safeRecall({ text: 'q', identity: identity() })).resolves.toEqual([])
  })

  it('rethrows in closed failure mode', async () => {
    const { service } = recallService(
      async () => {
        throw new MemoryError('UNAVAILABLE', 'offline', { retryable: true })
      },
      { enabled: true, failureMode: 'closed' },
    )
    await expect(service.safeRecall({ text: 'q', identity: identity() })).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
  })

  it('only reads the caller session scope, not another session', async () => {
    const { service } = recallService(hits(record('1', 'mine', SESSION_SCOPE), record('2', 'other', foreign)))
    const result = await service.recall({ text: 'q', identity: identity() })
    expect(result).toHaveLength(1)
  })
})

describe('recall provenance', () => {
  it('records only the hits that survive the scope policy, with the configured search type', async () => {
    const { service, provenance } = recallService(
      hits(record('1', 'mine'), record('2', 'foreign', foreign)),
      { recall: { searchType: 'GRAPH_COMPLETION' } },
    )
    await service.recall({ text: 'anything', identity: identity(), limit: 5 })
    expect(provenance.calls).toHaveLength(1)
    expect(provenance.calls[0]?.ids).toEqual(['1'])
    expect(provenance.calls[0]?.searchType).toBe('GRAPH_COMPLETION')
  })

  it('never records when the backend returned nothing readable', async () => {
    const { service, provenance } = recallService(hits(record('2', 'foreign', foreign)))
    await service.recall({ text: 'anything', identity: identity(), limit: 5 })
    expect(provenance.calls).toHaveLength(0)
  })

  it('does not let an index failure break a recall', async () => {
    const { service } = recallService(hits(record('1', 'mine')))
    const failing = new RecallService(
      { adapter: { ...({} as MemoryAdapter), recall: hits(record('1', 'mine')) }, config, metrics: new Metrics() },
      {
        cwd: PROJECT_ID,
        provenanceIndex: {
          recordRecall() {
            throw new Error('disk full')
          },
        },
      },
    )
    await expect(failing.recall({ text: 'anything', identity: identity(), limit: 5 })).resolves.toHaveLength(1)
    await expect(service.recall({ text: 'anything', identity: identity(), limit: 5 })).resolves.toHaveLength(1)
  })
})
