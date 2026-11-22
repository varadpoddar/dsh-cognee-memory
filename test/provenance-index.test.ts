import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROVENANCE_EXCERPT_CHARS,
  ProvenanceIndex,
  isAddressableMemoryId,
  resolveProvenancePath,
} from '../src/memory/provenance-index.js'
import type { RecallHit, ScopeRef } from '../src/types.js'

const temporary: string[] = []
const PROJECT: ScopeRef = { scope: 'project', id: 'demo-project' }
const OTHER_PROJECT: ScopeRef = { scope: 'project', id: 'other-project' }

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function file(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cognee-provenance-'))
  temporary.push(directory)
  return join(directory, 'provenance.json')
}

function hit(id: string, text: string, scope: ScopeRef = PROJECT, createdAt = '2026-01-02T03:04:05.000Z'): RecallHit {
  return { record: { id, text, scope, createdAt }, score: 0.9 }
}

function index(options: { maxEntries?: number } = {}): ProvenanceIndex {
  return new ProvenanceIndex({
    filePath: file(),
    now: () => new Date('2026-02-01T00:00:00.000Z'),
    ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
  })
}

describe('provenance index', () => {
  it('records what surfaced a memory, with dataset name, search type, confidence, and excerpt', () => {
    const store = index()
    store.recordRecall([hit('mem-1', 'Release codename: amber-otter-7731')], {
      identity: { principalId: 'operator' },
      searchType: 'GRAPH_COMPLETION',
    })
    const entry = store.get('mem-1', { principalId: 'operator', readableScopes: [PROJECT] })
    expect(entry).toBeDefined()
    expect(entry?.dataset.name).toBe('dsh-project-demo-project')
    expect(entry?.dataset.id).toBeUndefined()
    expect(entry?.surfaced).toEqual({
      searchType: 'GRAPH_COMPLETION',
      confidence: 'high',
      at: '2026-02-01T00:00:00.000Z',
    })
    expect(entry?.ingest.state).toBe('indexed')
    expect(entry?.createdAt).toBe('2026-01-02T03:04:05.000Z')
    expect(entry?.excerpt).toContain('amber-otter-7731')
    expect(entry?.scope).toEqual(PROJECT)
  })

  it('persists atomically and reloads the same entries', () => {
    const path = file()
    const first = new ProvenanceIndex({ filePath: path, now: () => new Date('2026-02-01T00:00:00.000Z') })
    first.recordRecall([hit('mem-1', 'alpha')], { identity: { principalId: 'operator' } })
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { version: number; entries: unknown[] }
    expect(raw.version).toBe(1)
    expect(raw.entries).toHaveLength(1)

    const second = new ProvenanceIndex({ filePath: path })
    expect(second.size()).toBe(1)
    expect(second.get('mem-1', { principalId: 'operator', readableScopes: [PROJECT] })?.excerpt).toBe('alpha')
  })

  it('bounds retention and evicts the least recently updated entry', () => {
    const store = index({ maxEntries: 2 })
    store.recordRecall([hit('mem-1', 'one')], { identity: { principalId: 'operator' } })
    store.recordRecall([hit('mem-2', 'two')], { identity: { principalId: 'operator' } })
    store.recordRecall([hit('mem-3', 'three')], { identity: { principalId: 'operator' } })
    expect(store.size()).toBe(2)
    expect(store.get('mem-1', { principalId: 'operator', readableScopes: [PROJECT] })).toBeUndefined()
    expect(store.get('mem-3', { principalId: 'operator', readableScopes: [PROJECT] })).toBeDefined()
  })

  it('truncates the excerpt and redacts credential shapes', () => {
    const store = index()
    store.recordRecall(
      [
        hit('mem-1', `token sk-live-abcdefghijklmnopqrstuvwxyz ${'x'.repeat(PROVENANCE_EXCERPT_CHARS * 2)}`),
      ],
      { identity: { principalId: 'operator' } },
    )
    const entry = store.get('mem-1', { principalId: 'operator', readableScopes: [PROJECT] })
    expect(entry?.excerpt).not.toContain('sk-live-abcdefghijklmnopqrstuvwxyz')
    expect(entry?.excerpt.length).toBeLessThanOrEqual(PROVENANCE_EXCERPT_CHARS)
    expect(entry?.excerpt.endsWith('…')).toBe(true)
  })

  it('never serves another principal or an unreadable scope', () => {
    const store = index()
    store.recordRecall([hit('mem-1', 'alpha')], { identity: { principalId: 'operator' } })
    store.recordRecall([hit('mem-2', 'beta', OTHER_PROJECT)], { identity: { principalId: 'operator' } })
    expect(store.get('mem-1', { principalId: 'someone-else', readableScopes: [PROJECT] })).toBeUndefined()
    expect(store.get('mem-2', { principalId: 'operator', readableScopes: [PROJECT] })).toBeUndefined()
    expect(store.get('mem-2', { principalId: 'operator', readableScopes: [PROJECT, OTHER_PROJECT] })).toBeDefined()
    expect(store.get('unknown', { principalId: 'operator', readableScopes: [PROJECT] })).toBeUndefined()
    expect(store.list({ principalId: 'operator', readableScopes: [PROJECT] }).map((e) => e.id)).toEqual(['mem-1'])
  })

  it('links a superseded memory to its replacement in both directions', () => {
    const store = index()
    store.recordWrite({ id: 'mem-new', scope: PROJECT, identity: { principalId: 'operator' }, text: 'new' })
    store.recordWrite({
      id: 'mem-old',
      scope: PROJECT,
      identity: { principalId: 'operator' },
      text: 'old',
    })
    store.markSuperseded('mem-old', 'mem-new')
    const access = { principalId: 'operator', readableScopes: [PROJECT] }
    expect(store.get('mem-old', access)?.supersededBy).toBe('mem-new')
    expect(store.get('mem-old', access)?.ingest.state).toBe('superseded')
    expect(store.get('mem-new', access)?.supersedes).toBe('mem-old')
  })

  it('records write provenance, semantic key, and bounded source refs', () => {
    const store = index()
    store.recordWrite({
      id: 'mem-1',
      scope: PROJECT,
      identity: { principalId: 'operator' },
      text: 'alpha',
      semanticKey: 'release-codename',
      createdAt: '2026-01-03T00:00:00.000Z',
      provenance: { kind: 'task_outcome', source: 'task:task-7', taskId: 'task-7', sessionId: 'session-1' },
    })
    const entry = store.get('mem-1', { principalId: 'operator', readableScopes: [PROJECT] })
    expect(entry?.semanticKey).toBe('release-codename')
    expect(entry?.sources.map((s) => `${s.kind}:${s.ref}`)).toEqual(['task:task-7', 'session:session-1'])
    expect(entry?.createdAt).toBe('2026-01-03T00:00:00.000Z')
  })

  it('attaches a backend dataset UUID once an inventory resolves it', () => {
    const path = file()
    const store = new ProvenanceIndex({ filePath: path })
    store.recordRecall([hit('mem-1', 'alpha')], { identity: { principalId: 'operator' } })
    store.setDatasetId('mem-1', '11111111-2222-3333-4444-555555555555')
    const access = { principalId: 'operator', readableScopes: [PROJECT] }
    expect(store.get('mem-1', access)?.dataset).toEqual({
      name: 'dsh-project-demo-project',
      id: '11111111-2222-3333-4444-555555555555',
    })
    expect(new ProvenanceIndex({ filePath: path }).get('mem-1', access)?.dataset.id).toBe(
      '11111111-2222-3333-4444-555555555555',
    )
  })

  it('starts empty and keeps working when the file is unreadable', () => {
    const path = file()
    writeFileSync(path, '{ not json', 'utf8')
    const store = new ProvenanceIndex({ filePath: path })
    expect(store.size()).toBe(0)
    store.recordRecall([hit('mem-1', 'alpha')], { identity: { principalId: 'operator' } })
    expect(store.size()).toBe(1)
  })

  it('rejects ids that are not safe path segments', () => {
    expect(isAddressableMemoryId('mem-1')).toBe(true)
    expect(isAddressableMemoryId('../etc/passwd')).toBe(false)
    expect(isAddressableMemoryId('a/b')).toBe(false)
    expect(isAddressableMemoryId('')).toBe(false)
    expect(isAddressableMemoryId('x'.repeat(201))).toBe(false)
  })

  it('resolves its default path under DSH_HOME', () => {
    expect(resolveProvenancePath({ DSH_HOME: '/var/lib/deepseek-harness/.dsh' })).toBe(
      '/var/lib/deepseek-harness/.dsh/plugins/cognee-memory/provenance.json',
    )
    expect(resolveProvenancePath({ COGNEE_MEMORY_PROVENANCE_FILE: '/tmp/x.json' })).toBe('/tmp/x.json')
  })
})
