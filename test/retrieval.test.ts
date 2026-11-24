import { describe, expect, it, vi } from 'vitest'
import { parseConfig } from '../src/config/schema.js'
import {
  estimateTokens,
  filterActiveHits,
  formatMemoryBlock,
} from '../src/memory/context-format.js'
import { RetrievalCoordinator } from '../src/memory/retrieval.js'
import { Metrics } from '../src/telemetry/metrics.js'
import type { RecallHit } from '../src/types.js'
import { FIXED_NOW, PROJECT_SCOPE, identity, record } from './helpers/fake-coordinator.js'

const QUESTION = 'What is the release codename and the deployment target?'

function config(overrides: Record<string, unknown> = {}) {
  return parseConfig({
    enabled: true,
    scopeDefaults: { projectId: '/workspace/demo' },
    ...overrides,
  })
}

function hit(id: string, text: string, score = 0.9, metadata?: Record<string, unknown>): RecallHit {
  const base = record(id, text)
  return {
    score,
    record: {
      ...base.record,
      ...(metadata === undefined
        ? {}
        : { metadata: metadata as RecallHit['record']['metadata'] }),
    },
  }
}

function coordinator(
  safeRecall: ReturnType<typeof vi.fn>,
  options: { config?: ReturnType<typeof config>; metrics?: Metrics; now?: () => number } = {},
) {
  const cfg = options.config ?? config()
  return {
    cfg,
    coordinator: new RetrievalCoordinator({
      recall: { safeRecall } as never,
      config: cfg,
      identity: identity(),
      ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
  }
}

describe('RetrievalCoordinator', () => {
  it('merges a stable principal/project layer with the real user question', async () => {
    const safeRecall = vi.fn(async (input: { text: string }) =>
      input.text === QUESTION
        ? [hit('2', 'Release codename: amber-otter-7731', 0.88)]
        : [hit('1', 'Convention: deployments go to CT 103', 0.7)],
    )
    const { coordinator: retrieval } = coordinator(safeRecall)
    const outcome = await retrieval.retrieve({ query: QUESTION, turn: 1 })
    expect(safeRecall).toHaveBeenCalledTimes(2)
    expect((safeRecall.mock.calls[0]?.[0] as { text: string }).text).toContain('Durable context for')
    expect((safeRecall.mock.calls[1]?.[0] as { text: string }).text).toBe(QUESTION)
    for (const call of safeRecall.mock.calls) {
      expect((call[0] as unknown as { identity: unknown }).identity).toEqual(identity())
    }
    expect(outcome.block.split('\n')[0]).toBe('Known context:')
    expect(outcome.block).toContain('amber-otter-7731')
    expect(outcome.block).toContain('CT 103')
    expect(outcome.queryHits).toBe(1)
    expect(outcome.degraded).toBe(false)
  })

  it('reuses the stable layer across steps inside the refresh window', async () => {
    const safeRecall = vi.fn(async (input: { text: string }) =>
      input.text === QUESTION ? [hit('2', 'query result')] : [hit('1', 'stable result')],
    )
    const { coordinator: retrieval } = coordinator(safeRecall)
    await retrieval.retrieve({ query: QUESTION, turn: 1 })
    await retrieval.retrieve({ query: 'another step question', turn: 1 })
    // stable once + one query per call
    expect(safeRecall).toHaveBeenCalledTimes(3)
  })

  it('refreshes the stable layer after stableRefreshMs', async () => {
    let clock = 1_000
    const safeRecall = vi.fn(async () => [hit('1', 'stable')])
    const { coordinator: retrieval } = coordinator(safeRecall, {
      config: config({ retrieval: { stableRefreshMs: 1_000 } }),
      now: () => clock,
    })
    await retrieval.retrieve({ query: QUESTION, turn: 1 })
    expect(safeRecall).toHaveBeenCalledTimes(2)
    clock += 2_000
    await retrieval.retrieve({ query: QUESTION, turn: 1 })
    expect(safeRecall).toHaveBeenCalledTimes(4)
  })

  it('enforces the strict combined token cap (300 stable + 900 query)', async () => {
    const long = 'x'.repeat(2_500)
    const safeRecall = vi.fn(async (input: { text: string }) =>
      input.text === QUESTION
        ? Array.from({ length: 6 }, (_, index) => hit(`q${index}`, `${long} q${index}`))
        : Array.from({ length: 6 }, (_, index) => hit(`s${index}`, `${long} s${index}`)),
    )
    const { coordinator: retrieval, cfg } = coordinator(safeRecall)
    const outcome = await retrieval.retrieve({ query: QUESTION, turn: 1 })
    expect(estimateTokens(outcome.block)).toBeLessThanOrEqual(
      cfg.retrieval.stableTokens + cfg.retrieval.queryTokens,
    )
    expect(outcome.tokens).toBe(estimateTokens(outcome.block))
    // whole items are dropped, never split
    expect(outcome.block).not.toMatch(/x{1201,}/)
  })

  it('reserves item capacity for the query layer so stable context cannot crowd out a matching fact', async () => {
    // Scenario-D crowd-out, as recorded in docs/EVALUATION.md: the adapter
    // ranked the maintenance fact first for the real question, but eight
    // high-scoring stable items filled every item slot, so the query layer got
    // max(0, 8 - 8) = 0 slots and the fact never reached the injected block.
    const stableHits = Array.from({ length: 8 }, (_, index) =>
      hit(`s${index}`, `stable filler ${index}`, 0.95),
    )
    const queryHits = [
      hit('maintenance', 'The maintenance window for this project is 03:00-04:00 UTC', 0.99),
      ...Array.from({ length: 7 }, (_, index) => hit(`q${index}`, `query filler ${index}`, 0.9)),
    ]
    const safeRecall = vi.fn(async (input: { text: string }) =>
      input.text === QUESTION ? queryHits : stableHits,
    )
    const { coordinator: retrieval, cfg } = coordinator(safeRecall)
    const outcome = await retrieval.retrieve({ query: QUESTION, turn: 1 })
    const lines = outcome.block.split('\n').filter((line) => line.startsWith('- '))
    expect(outcome.block).toContain('maintenance window for this project is 03:00-04:00 UTC')
    expect(outcome.queryHits).toBeGreaterThanOrEqual(1)
    expect(lines.length).toBeLessThanOrEqual(cfg.retrieval.maxItems)
    // the stable layer keeps its own 300-token cap and can no longer take every slot
    expect(lines.filter((line) => line.includes('stable filler')).length).toBeLessThanOrEqual(4)
    expect(outcome.tokens).toBeLessThanOrEqual(
      cfg.retrieval.stableTokens + cfg.retrieval.queryTokens,
    )
  })

  it('keeps at most 8 items, stable layer first', async () => {
    const safeRecall = vi.fn(async (input: { text: string }) =>
      input.text === QUESTION
        ? Array.from({ length: 8 }, (_, index) => hit(`q${index}`, `query memory ${index}`))
        : Array.from({ length: 8 }, (_, index) => hit(`s${index}`, `stable memory ${index}`)),
    )
    const { coordinator: retrieval, cfg } = coordinator(safeRecall)
    const outcome = await retrieval.retrieve({ query: QUESTION, turn: 1 })
    const lines = outcome.block.split('\n').filter((line) => line.startsWith('- '))
    expect(lines).toHaveLength(cfg.retrieval.maxItems)
    expect(lines[0]).toContain('stable memory 0')
  })

  it('drops superseded, revoked, and expired records before ranking', async () => {
    const hits = [
      hit('live', 'live memory'),
      hit('superseded', 'superseded memory', 0.9, { supersededBy: 'live' }),
      hit('revoked', 'revoked memory', 0.9, { revoked: true }),
      hit('expired', 'expired memory', 0.9, { expiresAt: '2025-01-01T00:00:00.000Z' }),
      hit('future', 'future memory', 0.9, { expiresAt: '2099-01-01T00:00:00.000Z' }),
    ]
    expect(filterActiveHits(hits, Date.parse(FIXED_NOW)).map((item) => item.record.id)).toEqual([
      'live',
      'future',
    ])
    const safeRecall = vi.fn(async (input: { text: string }) =>
      input.text === QUESTION ? hits : [],
    )
    const { coordinator: retrieval } = coordinator(safeRecall)
    const outcome = await retrieval.retrieve({ query: QUESTION, turn: 1 })
    expect(outcome.block).toContain('live memory')
    expect(outcome.block).toContain('future memory')
    expect(outcome.block).not.toContain('superseded memory')
    expect(outcome.block).not.toContain('revoked memory')
    expect(outcome.block).not.toContain('expired memory')
  })

  it('stops at the budget without throwing when the backend never answers', async () => {
    const safeRecall = vi.fn(() => new Promise<never>(() => undefined))
    const metrics = new Metrics()
    const { coordinator: retrieval } = coordinator(safeRecall, {
      config: config({ retrieval: { budgetMs: 50 } }),
      metrics,
    })
    const started = Date.now()
    const outcome = await retrieval.retrieve({ query: QUESTION, turn: 1 })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(outcome.block).toBe('')
    expect(outcome.degraded).toBe(true)
    expect(metrics.snapshot().counters['retrieval.empty']).toBe(1)
    expect(metrics.snapshot().counters['retrieval.failures']).toBe(2)
  })

  it('serves the query layer when only the stable layer fails', async () => {
    const safeRecall = vi.fn(async (input: { text: string }) => {
      if (input.text === QUESTION) return [hit('q1', 'query hit')]
      throw new Error('stable down')
    })
    const { coordinator: retrieval } = coordinator(safeRecall)
    const outcome = await retrieval.retrieve({ query: QUESTION, turn: 1 })
    expect(outcome.degraded).toBe(true)
    expect(outcome.block).toContain('query hit')
  })

  it('records first-turn hit and miss counters truthfully', async () => {
    const metrics = new Metrics()
    const safeRecall = vi.fn(async (input: { text: string }) =>
      input.text === QUESTION ? [hit('q1', 'answer')] : [],
    )
    const { coordinator: retrieval } = coordinator(safeRecall, { metrics })
    await retrieval.retrieve({ query: QUESTION, turn: 1 })
    await retrieval.retrieve({ query: 'no such memory', turn: 1 })
    const counters = metrics.snapshot().counters
    expect(counters['recall.firstTurnHits']).toBe(1)
    expect(counters['recall.firstTurnMisses']).toBe(1)
    expect(metrics.snapshot().samples['recall.latencyMs'].count).toBe(3)
    expect(metrics.snapshot().samples['context.usage'].last).toBeGreaterThan(0)
    expect(counters['memory.context.consumed']).toBeGreaterThan(0)
  })

  it('emits no block and no context sample when nothing is recalled', async () => {
    const metrics = new Metrics()
    const safeRecall = vi.fn(async () => [])
    const { coordinator: retrieval } = coordinator(safeRecall, { metrics })
    const outcome = await retrieval.retrieve({ query: QUESTION, turn: 1 })
    expect(outcome.block).toBe('')
    expect(metrics.snapshot().samples['context.usage'].count).toBe(0)
    expect(metrics.snapshot().counters['retrieval.empty']).toBe(1)
  })

  it('clears the stable cache on demand', async () => {
    const safeRecall = vi.fn(async () => [hit('1', 'stable')])
    const { coordinator: retrieval } = coordinator(safeRecall)
    await retrieval.retrieve({ query: QUESTION, turn: 1 })
    retrieval.clear()
    await retrieval.retrieve({ query: QUESTION, turn: 1 })
    expect(safeRecall).toHaveBeenCalledTimes(4)
  })

  it('adds an absolute per-memory link without changing the configured token budget', async () => {
    const safeRecall = vi.fn(async () => [hit('memory-1', 'Release codename: amber-otter-7731')])
    const { coordinator: retrieval, cfg } = coordinator(safeRecall, {
      config: config({ settings: { publicBaseUrl: 'https://dsh.example/' } }),
    })
    const outcome = await retrieval.retrieve({ query: QUESTION, turn: 1 })
    expect(outcome.block).toContain('amber-otter-7731')
    expect(outcome.block).toContain(
      'https://dsh.example/plugins/cognee-memory/memory/memory-1',
    )
    expect(outcome.tokens).toBeLessThanOrEqual(
      cfg.retrieval.stableTokens + cfg.retrieval.queryTokens,
    )
    expect(cfg.retrieval.stableTokens + cfg.retrieval.queryTokens).toBe(1_200)
  })

  it('formats label, scope, and date through one shared contract', () => {
    const block = formatMemoryBlock(
      [hit('1', 'alpha', 0.95), hit('2', 'beta', 0.5), hit('3', 'gamma', 0.1)],
      { maxTokens: 500, maxItems: 3 },
    )
    expect(block.text).toContain('- alpha · project · 2026-01-01')
    expect(block.text).toContain('- beta · project · 2026-01-01')
    expect(block.text).toContain('- gamma · project · 2026-01-01')
    expect(block.text).not.toContain('untrusted')
  })
})
