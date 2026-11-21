import { describe, expect, it } from 'vitest'
import {
  DedupIndex,
  dedupeKey,
  findNearDuplicate,
  jaccardSimilarity,
  normalizeMemoryText,
} from '../src/memory/deduplication.js'
import { makeScopeRef } from '../src/memory/scopes.js'

const project = makeScopeRef('project', '/workspace/demo')
const other = makeScopeRef('project', '/workspace/other')

describe('memory deduplication', () => {
  it('normalizes case, punctuation, whitespace, and unicode forms', () => {
    expect(normalizeMemoryText('  Hello,   WORLD!  ')).toBe('hello world')
    expect(normalizeMemoryText('Café')).toBe(normalizeMemoryText('Cafe\u0301'))
  })

  it('creates stable scope-sensitive dedupe keys', () => {
    expect(dedupeKey(project, 'Hello world')).toBe(dedupeKey(project, 'hello, world'))
    expect(dedupeKey(project, 'hello')).not.toBe(dedupeKey(project, 'hello world'))
    expect(dedupeKey(project, 'hello')).not.toBe(dedupeKey(other, 'hello'))
  })

  it('computes Jaccard similarity with explicit edge cases', () => {
    expect(jaccardSimilarity('', '')).toBe(1)
    expect(jaccardSimilarity('', 'alpha')).toBe(0)
    expect(jaccardSimilarity('alpha beta', 'alpha beta')).toBe(1)
    expect(jaccardSimilarity('alpha beta', 'alpha gamma')).toBeCloseTo(1 / 3)
  })

  it('finds exact and near duplicates above the threshold', () => {
    const candidates = [
      { id: '1', text: 'deploy target is blue', scope: project },
      { id: '2', text: 'entirely different', scope: project },
    ]
    expect(findNearDuplicate('Deploy target is blue!', candidates, 0.9)?.id).toBe('1')
    expect(findNearDuplicate('deploy target is green', candidates, 0.9)).toBeUndefined()
  })

  it('maintains a bounded exact index per scope', () => {
    const index = new DedupIndex()
    index.add({ id: '1', text: 'alpha', scope: project, createdAt: '2026-01-01T00:00:00.000Z' })
    expect(index.findExact(project, 'ALPHA')).toBe('1')
    expect(index.findExact(other, 'alpha')).toBeUndefined()
    expect(index.size()).toBe(1)
    index.clear()
    expect(index.findExact(project, 'alpha')).toBeUndefined()
  })

  it('searches near duplicates within one scope only', () => {
    const index = new DedupIndex()
    index.add({
      id: '1',
      text: 'alpha beta gamma',
      scope: other,
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    expect(index.findNear(project, 'alpha beta gamma', 0.8)).toBeUndefined()
    expect(index.findNear(other, 'alpha beta gamma', 0.8)?.id).toBe('1')
  })
})
