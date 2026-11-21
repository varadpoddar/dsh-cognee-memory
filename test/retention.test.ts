import { describe, expect, it } from 'vitest'
import { isExpired, planRetention } from '../src/memory/retention.js'
import { makeScopeRef } from '../src/memory/scopes.js'
import type { MemoryRecord } from '../src/types.js'

const scopeA = makeScopeRef('project', '/a')
const scopeB = makeScopeRef('project', '/b')
const now = new Date('2026-06-01T00:00:00.000Z')

function record(id: string, createdAt: string, scope = scopeA): MemoryRecord {
  return { id, text: id, createdAt, scope }
}

describe('retention planning', () => {
  it('marks records past maxAgeDays and invalid dates as expired', () => {
    expect(isExpired(record('a', '2026-01-01T00:00:00.000Z'), now, 90)).toBe(true)
    expect(isExpired(record('b', '2026-05-30T00:00:00.000Z'), now, 90)).toBe(false)
    expect(isExpired(record('c', 'not-a-date'), now, 90)).toBe(true)
  })

  it('evicts expired records without mutating the input', () => {
    const records = [
      record('old', '2025-01-01T00:00:00.000Z'),
      record('fresh', '2026-05-30T00:00:00.000Z'),
    ]
    const plan = planRetention(records, { maxAgeDays: 90, maxRecordsPerScope: 10 }, now)
    expect(plan.keep.map((item) => item.id)).toEqual(['fresh'])
    expect(plan.evict.map((item) => item.id)).toEqual(['old'])
    expect(records).toHaveLength(2)
  })

  it('evicts the oldest records above the per-scope cap', () => {
    const records = [
      record('newest', '2026-05-03T00:00:00.000Z'),
      record('oldest', '2026-05-01T00:00:00.000Z'),
      record('middle', '2026-05-02T00:00:00.000Z'),
    ]
    const plan = planRetention(records, { maxAgeDays: 365, maxRecordsPerScope: 2 }, now)
    expect(plan.keep.map((item) => item.id)).toEqual(['newest', 'middle'])
    expect(plan.evict.map((item) => item.id)).toEqual(['oldest'])
  })

  it('applies caps independently per scope', () => {
    const records = [
      record('a1', '2026-05-01T00:00:00.000Z', scopeA),
      record('a2', '2026-05-02T00:00:00.000Z', scopeA),
      record('b1', '2026-05-01T00:00:00.000Z', scopeB),
    ]
    const plan = planRetention(records, { maxAgeDays: 365, maxRecordsPerScope: 1 }, now)
    expect(plan.keep.map((item) => item.id).sort()).toEqual(['a2', 'b1'])
  })

  it('preserves caller order in both partitions', () => {
    const records = [
      record('z', '2026-05-01T00:00:00.000Z'),
      record('a', '2026-05-02T00:00:00.000Z'),
      record('m', '2026-05-03T00:00:00.000Z'),
    ]
    const plan = planRetention(records, { maxAgeDays: 365, maxRecordsPerScope: 2 }, now)
    expect(plan.keep.map((item) => item.id)).toEqual(['a', 'm'])
    expect(plan.evict.map((item) => item.id)).toEqual(['z'])
  })
})
