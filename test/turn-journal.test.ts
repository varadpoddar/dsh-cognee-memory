import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config/schema.js'
import { IngestQueue, contentHashOf, readQueueSnapshot } from '../src/queue/store.js'
import { chunkText, journalQueuePath, TurnJournal } from '../src/memory/turn-journal.js'

function queueIn(dir: string): IngestQueue {
  return IngestQueue.open({ filePath: join(dir, 'ingest-queue.jsonl'), syncWrites: true })
}

function journalFor(dir: string, overrides: Record<string, unknown> = {}): { journal: TurnJournal; queue: IngestQueue } {
  const config = parseConfig({
    enabled: true,
    scopeDefaults: { projectId: 'varad/mac-history' },
    ingestion: { journal: { enabled: true, ...overrides } },
  })
  const queue = queueIn(dir)
  return { journal: new TurnJournal({ config, queue }), queue }
}

describe('chunkText', () => {
  it('keeps short text as one part and never loses content', () => {
    expect(chunkText('hello world', 100)).toEqual(['hello world'])
    const text = 'a'.repeat(250)
    const parts = chunkText(text, 100)
    expect(parts.length).toBe(3)
    expect(parts.join('')).toHaveLength(250)
  })

  it('prefers a space or newline break without dropping characters', () => {
    const text = `${'x'.repeat(60)} ${'y'.repeat(60)}`
    const [first] = chunkText(text, 80)
    expect(first?.endsWith('x')).toBe(true)
    expect(first).not.toContain('y')
  })
})

describe('turn journal', () => {
  it('queues both sides of a conversation as separate tasks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-'))
    const { journal, queue } = journalFor(dir)
    const report = journal.recordTurn({
      sessionId: 's1',
      turn: 3,
      messages: [
        { role: 'user', text: 'what changed in the deploy?', seq: 1 },
        { role: 'assistant', text: 'the timer moved to 04:00', seq: 2 },
      ],
    })
    expect(report).toEqual({ added: 2, duplicates: 0, skipped: 0 })
    const items = queue.list('pending')
    expect(items.map((item) => item.source.role).sort()).toEqual(['assistant', 'user'])
    expect(items.every((item) => item.scope === 'dsh-project-varad-mac-history-5c5a11e6b8d6859e32a4')).toBe(true)
    expect(items.every((item) => item.source.sessionId === 's1' && item.source.turnIndex === 3)).toBe(true)
  })

  it('keeps two identical messages as two tasks (seeded hash)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-'))
    const { journal, queue } = journalFor(dir)
    journal.recordTurn({
      sessionId: 's1',
      turn: 1,
      messages: [
        { role: 'user', text: 'continue', seq: 1 },
        { role: 'user', text: 'continue', seq: 2 },
      ],
    })
    expect(queue.status().counts.pending).toBe(2)
    // Replaying the same turn is idempotent.
    const replay = journal.recordTurn({
      sessionId: 's1',
      turn: 1,
      messages: [
        { role: 'user', text: 'continue', seq: 1 },
        { role: 'user', text: 'continue', seq: 2 },
      ],
    })
    expect(replay.added).toBe(0)
    expect(replay.duplicates).toBe(2)
  })

  it('omits agent answers when includeAssistant is false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-'))
    const { journal, queue } = journalFor(dir, { includeAssistant: false })
    const report = journal.recordTurn({
      sessionId: 's1',
      turn: 1,
      messages: [
        { role: 'user', text: 'hello there', seq: 1 },
        { role: 'assistant', text: 'hi', seq: 2 },
      ],
    })
    expect(report.added).toBe(1)
    expect(report.skipped).toBe(1)
    expect(queue.list('pending')[0]?.source.role).toBe('user')
  })

  it('scrubs shaped secrets before the text touches disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-'))
    const { journal } = journalFor(dir)
    journal.recordTurn({
      sessionId: 's1',
      turn: 1,
      messages: [{ role: 'user', text: 'deploy with ghp_abcdefghijklmnopqrstuvwxyz0123456789 now', seq: 1 }],
    })
    const onDisk = readFileSync(join(dir, 'ingest-queue.jsonl'), 'utf8')
    expect(onDisk).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    expect(onDisk).toContain('[REDACTED:github_token]')
  })

  it('splits a long message into numbered parts and keeps every character', () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-'))
    const { journal, queue } = journalFor(dir, { chunkChars: 500 })
    const text = 'paragraph. '.repeat(100)
    journal.recordTurn({ sessionId: 's1', turn: 1, messages: [{ role: 'assistant', text, seq: 7 }] })
    const items = queue.list('pending')
    expect(items.length).toBeGreaterThan(1)
    expect(items.every((item) => item.source.partOf === items.length)).toBe(true)
    expect(items.map((item) => item.source.partIndex)).toEqual(items.map((_, index) => index))
    expect(items.map((item) => item.text).join('').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''))
  })

  it('does nothing when the journal is disabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-'))
    const { journal, queue } = journalFor(dir, { enabled: false })
    expect(journal.recordTurn({ sessionId: 's1', turn: 1, messages: [{ role: 'user', text: 'x', seq: 1 }] })).toEqual({
      added: 0,
      duplicates: 0,
      skipped: 0,
    })
    expect(queue.status().total).toBe(0)
  })
})

describe('queue task lifecycle', () => {
  it('removes a task only after it is completed, and remembers its hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-'))
    const queue = queueIn(dir)
    const text = 'a completed task'
    const scope = 'dsh-project-p'
    const entry = { text, scope, dedupeKey: 's1:1:1:user:0' }
    const first = queue.enqueue([entry])
    expect(first.added).toBe(1)
    const [claimed] = queue.claim({ limit: 1, workerId: 'w' })
    expect(claimed?.state).toBe('inflight')
    queue.markDone(claimed?.id ?? '')
    expect(queue.status().counts.done).toBe(1)
    const pruned = queue.pruneDone()
    expect(pruned).toEqual({ removed: 1, remaining: 0 })
    expect(queue.status().total).toBe(0)
    // Replay after removal is still a duplicate: the tombstone remembers it.
    expect(queue.enqueue([entry])).toMatchObject({ added: 0, duplicates: 1 })
    expect(readFileSync(queue.tombstonePath, 'utf8')).toContain(contentHashOf(scope, text, entry.dedupeKey))
  })

  it('keeps failed and pending tasks through a prune', () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-'))
    const queue = queueIn(dir)
    queue.enqueue([{ text: 'failed task', scope: 'dsh-project-p', dedupeKey: 'b' }])
    const [failed] = queue.claim({ limit: 1, workerId: 'w' })
    queue.markFailed(failed?.id ?? '', 'backend refused the payload', { permanent: true })
    queue.enqueue([{ text: 'pending task', scope: 'dsh-project-p', dedupeKey: 'a' }])
    expect(queue.pruneDone()).toEqual({ removed: 0, remaining: 2 })
    const reopened = queueIn(dir)
    expect(reopened.status().counts.failed).toBe(1)
    expect(reopened.status().counts.pending).toBe(1)
  })

  it('never claims a permanently failed task and does not count it as due', () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-'))
    const queue = queueIn(dir)
    queue.enqueue([{ text: 'refused payload', scope: 'dsh-project-p', dedupeKey: 'c' }])
    const [claimed] = queue.claim({ limit: 1, workerId: 'w' })
    queue.markFailed(claimed?.id ?? '', 'memory backend denied the request', { permanent: true })
    expect(queue.status().counts.failed).toBe(1)
    expect(queue.status().dueNow).toBe(0)
    expect(queue.claim({ limit: 5, workerId: 'w' })).toEqual([])
  })

  it('retries beyond the old six-attempt ceiling when the policy says so', () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-'))
    let now = 1_000
    const queue = IngestQueue.open({
      filePath: join(dir, 'q.jsonl'),
      now: () => now,
      backoff: { baseMs: 1, capMs: 1, maxAttempts: 1_000_000 },
    })
    queue.enqueue([{ text: 'flaky task', scope: 'dsh-project-p', dedupeKey: 'd' }])
    for (let attempt = 0; attempt < 8; attempt += 1) {
      now += 10
      const [claimed] = queue.claim({ limit: 1, workerId: 'w' })
      if (claimed === undefined) break
      queue.markFailed(claimed.id, 'temporarily unavailable')
    }
    const item = queue.list()[0]
    expect(item?.state).toBe('pending')
    expect(item?.attempts).toBe(8)
  })
})

describe('journalQueuePath', () => {
  it('honours the configured path, then the environment', () => {
    const config = parseConfig({ ingestion: { queue: { path: '/tmp/explicit.jsonl' } } })
    expect(journalQueuePath(config, {})).toBe('/tmp/explicit.jsonl')
    const fallback = parseConfig({})
    expect(journalQueuePath(fallback, { DSH_HOME: '/tmp/home' })).toBe(
      '/tmp/home/plugins/cognee-memory/ingest-queue.jsonl',
    )
  })
})

describe('readQueueSnapshot', () => {
  it('reflects a prune without reopening the queue (no stale list)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-'))
    const file = join(dir, 'ingest-queue.jsonl')
    const queue = IngestQueue.open({ filePath: file })
    queue.enqueue([{ text: 'finished task', scope: 'dsh-project-p', dedupeKey: 'x' }])
    const [claimed] = queue.claim({ limit: 1, workerId: 'w' })
    queue.markDone(claimed?.id ?? '')
    expect(readQueueSnapshot(file).status.counts.done).toBe(1)
    queue.pruneDone()
    const after = readQueueSnapshot(file)
    expect(after.status.total).toBe(0)
    expect(after.items).toHaveLength(0)
  })
})
