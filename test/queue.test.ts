import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { drainQueue, type DrainTarget } from '../src/queue/drain.js'
import { collectTranscriptEntries } from '../src/queue/producer.js'
import {
  DEFAULT_BACKOFF,
  IngestQueue,
  backoffDelayMs,
  contentHashOf,
  readQueueSnapshot,
  resolveQueuePath,
  type QueueItem,
} from '../src/queue/store.js'
import { parseEndpointSpecs } from '../src/cli/queue-cmd.js'
import { makeScopeRef, scopeKey } from '../src/memory/scopes.js'

const scope = makeScopeRef('project', 'queue-test')
const scopeKeyValue = scopeKey(scope)
const scopeRef = { scope: scope.scope, id: scope.id }

function freshQueue(now?: () => number) {
  const dir = mkdtempSync(join(tmpdir(), 'cognee-queue-'))
  const filePath = join(dir, 'queue.jsonl')
  return { dir, filePath, queue: IngestQueue.open({ filePath, ...(now === undefined ? {} : { now }) }) }
}

describe('queue store', () => {
  it('is idempotent by content hash across whitespace differences', () => {
    const { filePath } = freshQueue()
    const queue = IngestQueue.open({ filePath })
    const first = queue.enqueue([{ text: 'hello   world', scope: scopeKeyValue, scopeRef }])
    expect(first.added).toBe(1)

    const reopened = IngestQueue.open({ filePath })
    const second = reopened.enqueue([{ text: 'hello world\n', scope: scopeKeyValue, scopeRef }])
    expect(second.added).toBe(0)
    expect(second.duplicates).toBe(1)
    expect(contentHashOf(scopeKeyValue, ' hello  world ')).toBe(contentHashOf(scopeKeyValue, 'hello world'))
  })

  it('writes nothing on a dry run', () => {
    const { filePath } = freshQueue()
    const queue = IngestQueue.open({ filePath })
    const report = queue.enqueue([{ text: 'dry', scope: scopeKeyValue, scopeRef }], { dryRun: true })
    expect(report.added).toBe(1)
    expect(existsSync(filePath)).toBe(false)
    expect(queue.status().total).toBe(0)
  })

  it('survives a torn trailing line without losing prior items', () => {
    const { filePath } = freshQueue()
    const queue = IngestQueue.open({ filePath })
    queue.enqueue([{ text: 'first', scope: scopeKeyValue, scopeRef }], {})
    // Simulate an interrupted append.
    const { appendFileSync } = require('node:fs') as typeof import('node:fs')
    appendFileSync(filePath, '{"id":"torn", "conte')
    const reopened = IngestQueue.open({ filePath })
    expect(reopened.status().total).toBe(1)
    expect(reopened.enqueue([{ text: 'second', scope: scopeKeyValue, scopeRef }]).added).toBe(1)
  })

  it('requeues a lease that outlived its worker', () => {
    let clock = 1_000
    const now = () => clock
    const { filePath } = freshQueue(now)
    const queue = IngestQueue.open({ filePath, now, leaseMs: 5_000 })
    queue.enqueue([{ text: 'lease', scope: scopeKeyValue, scopeRef }])
    const claimed = queue.claim({ limit: 1, workerId: 'w1' })
    expect(claimed).toHaveLength(1)
    expect(queue.status().counts.inflight).toBe(1)

    // Worker died: no markDone/markFailed. A later process reclaims it.
    clock += 6_000
    const reopened = IngestQueue.open({ filePath, now, leaseMs: 5_000 })
    expect(reopened.status().counts.pending).toBe(1)
    expect(reopened.claim({ limit: 1, workerId: 'w2' })).toHaveLength(1)
  })

  it('schedules exponential backoff and stops at maxAttempts', () => {
    let clock = 10_000
    const now = () => clock
    const { filePath } = freshQueue(now)
    const queue = IngestQueue.open({ filePath, now })
    queue.enqueue([{ text: 'flaky', scope: scopeKeyValue, scopeRef }])

    const [item] = queue.claim({ limit: 1, workerId: 'w' })
    expect(item?.attempts).toBe(1)
    queue.markFailed(item!.id, 'boom')
    // Not due yet: the drain must not spin on a failure.
    expect(queue.claim({ limit: 1, workerId: 'w' })).toHaveLength(0)
    expect(queue.status().dueNow).toBe(0)

    clock += backoffDelayMs(1) + 1
    const [retry] = queue.claim({ limit: 1, workerId: 'w' })
    expect(retry?.attempts).toBe(2)
    queue.markFailed(retry!.id, 'boom')

    // Exhaust the budget; the item becomes terminal and stays put.
    for (let attempt = 3; attempt <= DEFAULT_BACKOFF.maxAttempts; attempt += 1) {
      clock += backoffDelayMs(attempt) + 1
      const [next] = queue.claim({ limit: 1, workerId: 'w' })
      expect(next).toBeDefined()
      queue.markFailed(next!.id, 'boom')
    }
    clock += DEFAULT_BACKOFF.capMs + 1
    expect(queue.claim({ limit: 1, workerId: 'w' })).toHaveLength(0)
    expect(queue.status().counts.failed).toBe(1)
  })

  it('compacts the log while preserving every live item', () => {
    const { filePath } = freshQueue()
    const queue = IngestQueue.open({ filePath })
    queue.enqueue(
      Array.from({ length: 300 }, (_, index) => ({ text: `chunk ${index}`, scope: scopeKeyValue, scopeRef })),
    )
    const [first] = queue.claim({ limit: 1, workerId: 'w' })
    queue.markDone(first!.id)
    const before = queue.status().lines
    const result = queue.compact()
    expect(result.after).toBe(queue.status().total)
    expect(before).toBeGreaterThanOrEqual(result.after)

    const reopened = IngestQueue.open({ filePath })
    expect(reopened.status().total).toBe(300)
    expect(reopened.status().counts.done).toBe(1)
    // A compacted log is one line per item, so it reloads without replaying history.
    expect(readFileSync(filePath, 'utf8').trim().split('\n')).toHaveLength(300)
  })

  it('does not drop rows a second writer appended after this one opened', () => {
    const { filePath } = freshQueue()
    const pruner = IngestQueue.open({ filePath })
    pruner.enqueue([{ text: 'done item', scope: scopeKeyValue, scopeRef }])
    const [claimed] = pruner.claim({ limit: 1, workerId: 'drain' })
    pruner.markDone(claimed!.id)

    // A second process (the summary backfill) opens after the pruner and
    // appends while the pruner still holds its pre-append snapshot.
    const writer = IngestQueue.open({ filePath })
    writer.enqueue(
      Array.from({ length: 5 }, (_, index) => ({ text: `summary ${index}`, scope: scopeKeyValue, scopeRef })),
    )

    expect(pruner.pruneDone().removed).toBe(1)
    const after = readQueueSnapshot(filePath)
    expect(after.items.map((item) => item.text).sort()).toEqual(
      Array.from({ length: 5 }, (_, index) => `summary ${index}`).sort(),
    )
    // The tombstone is durable, so a replay of the pruned item stays a no-op.
    const replay = IngestQueue.open({ filePath })
    expect(replay.enqueue([{ text: 'done item', scope: scopeKeyValue, scopeRef }]).duplicates).toBe(1)
  })

  it('compaction merges concurrent appends instead of rewriting them away', () => {
    const { filePath } = freshQueue()
    const compactor = IngestQueue.open({ filePath })
    compactor.enqueue([{ text: 'early', scope: scopeKeyValue, scopeRef }])
    const writer = IngestQueue.open({ filePath })
    writer.enqueue([{ text: 'late', scope: scopeKeyValue, scopeRef }])

    compactor.compact()
    const after = readQueueSnapshot(filePath)
    expect(after.items.map((item) => item.text).sort()).toEqual(['early', 'late'])
  })
})

describe('drain', () => {
  it('runs two workers over two endpoints without double-processing', async () => {
    const { filePath } = freshQueue()
    const queue = IngestQueue.open({ filePath })
    queue.enqueue(
      Array.from({ length: 10 }, (_, index) => ({ text: `turn ${index}`, scope: scopeKeyValue, scopeRef })),
    )
    const seen = new Map<string, number>()
    const makeTarget = (name: string, delayMs: number): DrainTarget => ({
      name,
      write: async (item: QueueItem) => {
        seen.set(item.id, (seen.get(item.id) ?? 0) + 1)
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      },
    })
    const summary = await drainQueue({
      queue,
      targets: [makeTarget('gpu0', 5), makeTarget('gpu1', 5)],
      workers: 2,
    })
    expect(summary.processed).toBe(10)
    expect(summary.failed).toBe(0)
    expect(summary.byTarget.gpu0).toBeGreaterThan(0)
    expect(summary.byTarget.gpu1).toBeGreaterThan(0)
    // Every item was written exactly once.
    expect([...seen.values()].every((count) => count === 1)).toBe(true)
    expect(queue.status().counts.done).toBe(10)
  })

  it('records a failure and keeps draining the rest', async () => {
    const { filePath } = freshQueue()
    const queue = IngestQueue.open({ filePath })
    queue.enqueue([
      { text: 'poison', scope: scopeKeyValue, scopeRef },
      { text: 'good', scope: scopeKeyValue, scopeRef },
    ])
    const summary = await drainQueue({
      queue,
      targets: [
        {
          name: 'gpu0',
          write: async (item) => {
            if (item.text === 'poison') throw new Error('cognify failed')
          },
        },
      ],
      workers: 1,
    })
    expect(summary.processed).toBe(1)
    expect(summary.failed).toBe(1)
    const pending = queue.status().counts.pending
    const done = queue.status().counts.done
    expect(pending).toBe(1)
    expect(done).toBe(1)
  })

  it('stops on the stop signal and leaves the remainder pending', async () => {
    const { filePath } = freshQueue()
    const queue = IngestQueue.open({ filePath })
    queue.enqueue(
      Array.from({ length: 6 }, (_, index) => ({ text: `turn ${index}`, scope: scopeKeyValue, scopeRef })),
    )
    let processed = 0
    let stopped = false
    const summary = await drainQueue({
      queue,
      targets: [
        {
          name: 'gpu0',
          write: async () => {
            processed += 1
            if (processed === 2) stopped = true
          },
        },
      ],
      workers: 1,
      shouldStop: () => stopped,
    })
    expect(summary.stopped).toBe(true)
    expect(summary.processed).toBeLessThan(6)
    expect(queue.status().counts.done + queue.status().counts.inflight).toBeLessThan(6)
  })

  it('writes a batch of 3 with ONE backend call and marks all done', async () => {
    const { filePath } = freshQueue()
    const queue = IngestQueue.open({ filePath })
    queue.enqueue(
      Array.from({ length: 3 }, (_, index) => ({ text: `summary ${index}`, scope: scopeKeyValue, scopeRef })),
    )
    const batches: string[][] = []
    const singles: string[] = []
    const summary = await drainQueue({
      queue,
      batchSize: 3,
      targets: [
        {
          name: 'gpu0',
          write: async (item) => {
            singles.push(item.id)
          },
          writeBatch: async (items) => {
            batches.push(items.map((item) => item.id))
            return items.map(() => ({ ok: true as const }))
          },
        },
      ],
      workers: 1,
    })
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(3)
    expect(singles).toEqual([])
    expect(summary.processed).toBe(3)
    expect(summary.failed).toBe(0)
    expect(summary.batches).toBe(1)
    expect(summary.batchSize).toBe(3)
    expect(queue.status().counts.done).toBe(3)
    expect(queue.status().counts.inflight).toBe(0)
  })

  it('isolates a poison item: its neighbours stay done, it is retried alone', async () => {
    const { filePath } = freshQueue()
    const queue = IngestQueue.open({ filePath })
    queue.enqueue(
      Array.from({ length: 3 }, (_, index) => ({ text: `summary ${index}`, scope: scopeKeyValue, scopeRef })),
    )
    const poison = 'summary 1'
    const retried: string[] = []
    const summary = await drainQueue({
      queue,
      batchSize: 3,
      targets: [
        {
          name: 'gpu0',
          write: async (item) => {
            retried.push(item.text)
            throw new Error('still poison')
          },
          writeBatch: async (items) =>
            items.map((item) =>
              item.text === poison ? { ok: false as const, error: 'cognify refused one document' } : { ok: true as const },
            ),
        },
      ],
      workers: 1,
    })
    expect(retried).toEqual([poison])
    expect(summary.processed).toBe(2)
    expect(summary.failed).toBe(1)
    expect(queue.status().counts.done).toBe(2)
    const failed = queue.status().counts.pending + queue.status().counts.failed
    expect(failed).toBe(1)
    expect(queue.status().counts.inflight).toBe(0)
  })

  it('falls back to per-item writes when the whole batch throws', async () => {
    const { filePath } = freshQueue()
    const queue = IngestQueue.open({ filePath })
    queue.enqueue(
      Array.from({ length: 2 }, (_, index) => ({ text: `doc ${index}`, scope: scopeKeyValue, scopeRef })),
    )
    const written: string[] = []
    const summary = await drainQueue({
      queue,
      batchSize: 2,
      targets: [
        {
          name: 'gpu0',
          write: async (item) => {
            written.push(item.text)
          },
          writeBatch: async () => {
            throw new Error('pipeline down')
          },
        },
      ],
      workers: 1,
    })
    expect(written.sort()).toEqual(['doc 0', 'doc 1'])
    expect(summary.processed).toBe(2)
    expect(summary.failed).toBe(0)
    expect(queue.status().counts.done).toBe(2)
  })

  it('never calls writeBatch when batchSize is 1', async () => {
    const { filePath } = freshQueue()
    const queue = IngestQueue.open({ filePath })
    queue.enqueue(
      Array.from({ length: 2 }, (_, index) => ({ text: `solo ${index}`, scope: scopeKeyValue, scopeRef })),
    )
    let batchCalls = 0
    let singleCalls = 0
    const summary = await drainQueue({
      queue,
      batchSize: 1,
      targets: [
        {
          name: 'gpu0',
          write: async () => {
            singleCalls += 1
          },
          writeBatch: async (items) => {
            batchCalls += 1
            return items.map(() => ({ ok: true as const }))
          },
        },
      ],
      workers: 1,
    })
    expect(batchCalls).toBe(0)
    expect(singleCalls).toBe(2)
    expect(summary.batchSize).toBe(1)
    expect(summary.processed).toBe(2)
  })
})

describe('endpoint specs', () => {
  it('parses named endpoints and falls back to the configured base URL', () => {
    expect(parseEndpointSpecs(undefined, 'http://10.20.10.15:8000/api/v1')).toEqual([
      { name: '10.20.10.15:8000', url: 'http://10.20.10.15:8000/api/v1' },
    ])
    expect(parseEndpointSpecs('gpu0=http://a:8888/v1,gpu1=http://b:8888/v1', 'http://x')).toEqual([
      { name: 'gpu0', url: 'http://a:8888/v1' },
      { name: 'gpu1', url: 'http://b:8888/v1' },
    ])
    expect(parseEndpointSpecs('http://a:8888/v1', 'http://x')).toEqual([{ name: 'a:8888', url: 'http://a:8888/v1' }])
  })

  it('resolves the queue path under the plugin state dir', () => {
    expect(resolveQueuePath({ DSH_HOME: '/tmp/dsh-home' } as NodeJS.ProcessEnv)).toBe(
      '/tmp/dsh-home/plugins/cognee-memory/ingest-queue.jsonl',
    )
    expect(resolveQueuePath({ COGNEE_MEMORY_QUEUE_FILE: '/tmp/q.jsonl' } as NodeJS.ProcessEnv)).toBe('/tmp/q.jsonl')
  })
})

describe('transcript producer', () => {
  it('produces one turn-granular entry per human message, newest session first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cognee-producer-'))
    const sessions = join(dir, 'sessions')
    const sessionA = join(sessions, 'proj', 'session-2026-11-01', 'session.v4.jsonl.zstd')
    const { mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs')
    const mkdir = (target: string): void => {
      mkdirSync(join(target, '..'), { recursive: true })
    }
    expect(mkdir).toBeDefined()
    mkdirSync(join(sessions, 'proj', 'session-2026-11-01'), { recursive: true })
    const frame = (event: unknown): Buffer => zstdCompressSync(`${JSON.stringify(event)}\n`)
    const body = Buffer.concat([
      frame({ type: 'session', id: 'session-a', createdAt: 1_700_000_000_000 }),
      frame({
        type: 'user/message',
        seq: 1,
        time: 1_700_000_001_000,
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'remember the deploy freeze' }] },
      }),
      frame({
        type: 'user/message',
        seq: 2,
        time: 1_700_000_002_000,
        data: { source: { kind: 'tool' }, content: [{ type: 'text', text: 'tool output' }] },
      }),
    ])
    writeFileSync(sessionA, body)

    const produced = collectTranscriptEntries({ sessionsDir: sessions, scope: scopeKeyValue, limitSessions: 5 })
    expect(produced.missing).toBe(false)
    expect(produced.entries).toHaveLength(1)
    expect(produced.entries[0]?.text).toBe('remember the deploy freeze')
    expect(produced.entries[0]?.source).toMatchObject({ sessionId: 'session-a', turnIndex: 1, role: 'user' })
    expect(produced.skipped.notHuman).toBe(1)
  })

  it('reports a missing sessions directory instead of inventing one', () => {
    const produced = collectTranscriptEntries({ sessionsDir: '/nonexistent/sessions', scope: scopeKeyValue })
    expect(produced.missing).toBe(true)
    expect(produced.entries).toHaveLength(0)
  })
})
