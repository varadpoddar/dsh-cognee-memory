import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryError } from '../src/errors.js'
import { Outbox, type OutboxOperation, type OutboxSinkResult } from '../src/memory/outbox.js'
import { Metrics } from '../src/telemetry/metrics.js'

const directories: string[] = []

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-outbox-'))
  directories.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of directories.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

function operation(
  overrides: Partial<Parameters<Outbox['enqueue']>[0]> = {},
): Parameters<Outbox['enqueue']>[0] {
  return {
    idempotencyKey: 'candidate-1',
    dataset: 'dsh-project-demo',
    operation: 'remember',
    content: 'the deploy target is CT 103',
    candidateVersion: 1,
    ...overrides,
  }
}

describe('Outbox', () => {
  it('enqueues a pending operation with a stable operation id', async () => {
    const dir = await tempDir()
    const outbox = new Outbox({ dir })
    const first = await outbox.enqueue(operation())
    const second = await outbox.enqueue(operation())
    expect(first.accepted).toBe(true)
    expect(second.accepted).toBe(false)
    expect(second.reason).toBe('duplicate')
    expect(first.operationId).toMatch(/^op-[0-9a-f]{32}$/)
    expect(second.operationId).toBe(first.operationId)
    const status = await outbox.status()
    expect(status).toMatchObject({ pending: 1, total: 1 })
  })

  it('stays idempotent across processes over the same directory', async () => {
    const dir = await tempDir()
    const one = new Outbox({ dir })
    const two = new Outbox({ dir })
    const first = await one.enqueue(operation())
    const replay = await two.enqueue(operation())
    expect(replay.accepted).toBe(false)
    expect(replay.operationId).toBe(first.operationId)
    expect((await two.status()).total).toBe(1)
  })

  it('completes only with a Cognee data reference', async () => {
    const dir = await tempDir()
    const metrics = new Metrics()
    const outbox = new Outbox({ dir, metrics })
    await outbox.enqueue(operation())
    const sink = vi.fn(async (_op: OutboxOperation): Promise<OutboxSinkResult> => ({
      status: 'complete',
      dataRef: 'cognee:dsh-project-demo#mem-123',
    }))
    const result = await outbox.drain(sink)
    expect(sink).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ processed: 1, completed: 1, failed: 0 })
    expect(await outbox.status()).toMatchObject({ complete: 1, pending: 0 })
    expect(metrics.snapshot().counters['outbox.completed']).toBe(1)
    const stored = await outbox.operationFor('candidate-1')
    expect(stored?.dataRef).toBe('cognee:dsh-project-demo#mem-123')
    expect(stored?.state).toBe('complete')
  })

  it('treats a success claim without a data reference as a failure', async () => {
    const dir = await tempDir()
    const metrics = new Metrics()
    const outbox = new Outbox({ dir, metrics, maxAttempts: 1 })
    await outbox.enqueue(operation())
    const sink = vi.fn(async (): Promise<OutboxSinkResult> => ({ status: 'complete', dataRef: '' }))
    const result = await outbox.drain(sink, { maxWaitMs: 0 })
    expect(result.failed).toBe(1)
    const stored = await outbox.operationFor('candidate-1')
    expect(stored?.state).toBe('failed')
    expect(stored?.reason).toBe('MISSING_DATA_REF')
    expect(stored?.retryable).toBe(false)
    expect(metrics.snapshot().counters['outbox.failed']).toBe(1)
  })

  it('never retries a permanent authorization failure', async () => {
    const dir = await tempDir()
    const metrics = new Metrics()
    const outbox = new Outbox({ dir, metrics })
    await outbox.enqueue(operation())
    const sink = vi.fn(async (): Promise<OutboxSinkResult> => {
      throw new MemoryError('FORBIDDEN', 'not allowed', { retryable: false })
    })
    const result = await outbox.drain(sink, { maxWaitMs: 5_000 })
    expect(sink).toHaveBeenCalledTimes(1)
    expect(result.failed).toBe(1)
    const stored = await outbox.operationFor('candidate-1')
    expect(stored?.state).toBe('failed')
    expect(stored?.attempts).toBe(1)
    expect(stored?.retryable).toBe(false)
    expect(stored?.reason).toBe('FORBIDDEN')
    expect(metrics.snapshot().counters['outbox.retried']).toBe(0)
  })

  it('retries a transient failure with exponential backoff, then completes', async () => {
    const dir = await tempDir()
    let clock = 1_000_000
    const slept: number[] = []
    const outbox = new Outbox({
      dir,
      baseBackoffMs: 100,
      maxBackoffMs: 400,
      maxAttempts: 3,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms)
        clock += ms
      },
    })
    await outbox.enqueue(operation())
    let attempt = 0
    const sink = vi.fn(async (): Promise<OutboxSinkResult> => {
      attempt += 1
      if (attempt === 1) throw new MemoryError('TIMEOUT', 'slow', { retryable: true })
      return { status: 'complete', dataRef: 'cognee:dsh-project-demo#mem-9' }
    })
    const result = await outbox.drain(sink)
    expect(sink).toHaveBeenCalledTimes(2)
    expect(slept).toEqual([100])
    expect(result).toMatchObject({ completed: 1, failed: 0 })
    expect((await outbox.operationFor('candidate-1'))?.attempts).toBe(2)
  })

  it('stops after maxAttempts and records the reason and retry count', async () => {
    const dir = await tempDir()
    let clock = 0
    const outbox = new Outbox({
      dir,
      baseBackoffMs: 100,
      maxBackoffMs: 200,
      maxAttempts: 3,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
    })
    await outbox.enqueue(operation())
    const sink = vi.fn(async (): Promise<OutboxSinkResult> => ({
      status: 'failed',
      reason: 'BACKEND',
      retryable: true,
    }))
    await outbox.drain(sink)
    expect(sink).toHaveBeenCalledTimes(3)
    const stored = await outbox.operationFor('candidate-1')
    expect(stored).toMatchObject({ state: 'failed', attempts: 3, retryable: false, reason: 'BACKEND' })
    expect(stored?.nextAttemptAt).toBeUndefined()
  })

  it('re-queues a processing entry whose lease expired (crash recovery)', async () => {
    const dir = await tempDir()
    const metrics = new Metrics()
    const outbox = new Outbox({ dir, leaseMs: 1_000, metrics, now: () => 10_000 })
    await outbox.enqueue(operation())
    // Simulate a process that died between "sent" and "recorded the outcome".
    const crashed = {
      type: 'operation',
      operation: {
        operationId: (await outbox.operationFor('candidate-1'))?.operationId,
        idempotencyKey: 'candidate-1',
        dataset: 'dsh-project-demo',
        operation: 'remember',
        content: 'the deploy target is CT 103',
        candidateVersion: 1,
        state: 'processing',
        attempts: 1,
        createdAt: new Date(5_000).toISOString(),
        updatedAt: new Date(5_000).toISOString(),
      },
    }
    await fs.appendFile(path.join(dir, 'outbox.jsonl'), `${JSON.stringify(crashed)}\n`)
    const recovered = await outbox.recover()
    expect(recovered.recovered).toBe(1)
    expect((await outbox.status()).pending).toBe(1)
    expect(metrics.snapshot().counters['outbox.recovered']).toBe(1)
    const sink = vi.fn(async (): Promise<OutboxSinkResult> => ({
      status: 'complete',
      dataRef: 'cognee:dsh-project-demo#mem-1',
    }))
    expect((await outbox.drain(sink)).completed).toBe(1)
  })

  it('leaves a fresh processing lease alone', async () => {
    const dir = await tempDir()
    const outbox = new Outbox({ dir, leaseMs: 60_000, now: () => 10_000 })
    await fs.writeFile(
      path.join(dir, 'outbox.jsonl'),
      `${JSON.stringify({
        type: 'operation',
        operation: {
          operationId: 'op-'.padEnd(35, '0'),
          idempotencyKey: 'busy',
          dataset: 'dsh-project-demo',
          operation: 'remember',
          content: 'busy write',
          candidateVersion: 1,
          state: 'processing',
          attempts: 1,
          createdAt: new Date(9_000).toISOString(),
          updatedAt: new Date(9_000).toISOString(),
        },
      })}\n`,
      { mode: 0o600 },
    )
    expect((await outbox.recover()).recovered).toBe(0)
    expect((await outbox.status()).processing).toBe(1)
  })

  it('skips corrupt lines and truncated records', async () => {
    const dir = await tempDir()
    const outbox = new Outbox({ dir })
    await outbox.enqueue(operation())
    await fs.appendFile(path.join(dir, 'outbox.jsonl'), '{"type":"operation","operation":{"bad\n')
    const status = await outbox.status()
    expect(status.total).toBe(1)
    expect(status.pending).toBe(1)
  })

  it('refuses to queue content that carries a credential', async () => {
    const dir = await tempDir()
    const outbox = new Outbox({ dir })
    const result = await outbox.enqueue(
      operation({ content: 'the api key is sk-live-abcdefghijklmnopqrstuvwxyz012345' }),
    )
    expect(result.accepted).toBe(false)
    expect(result.reason).toBe('secret')
    expect((await outbox.status()).total).toBe(0)
  })

  it('keeps the log and directory private', async () => {
    const dir = await tempDir()
    const outbox = new Outbox({ dir })
    await outbox.enqueue(operation())
    const file = await fs.stat(path.join(dir, 'outbox.jsonl'))
    const folder = await fs.stat(dir)
    expect(file.mode & 0o777).toBe(0o600)
    expect(folder.mode & 0o777).toBe(0o700)
  })

  it('reports a bounded, secret-free operations view', async () => {
    const dir = await tempDir()
    const outbox = new Outbox({ dir, maxAttempts: 1 })
    for (let index = 0; index < 60; index += 1) {
      await outbox.enqueue(operation({ idempotencyKey: `candidate-${index}`, content: `memory ${index}` }))
    }
    await outbox.drain(
      async (op): Promise<OutboxSinkResult> => ({
        status: 'complete',
        dataRef: `cognee:dsh-project-demo#${op.operationId}`,
      }),
    )
    const status = await outbox.status()
    expect(status.complete).toBe(60)
    expect(status.operations).toHaveLength(50)
    const serialized = JSON.stringify(status)
    expect(serialized).not.toContain('memory 0')
    expect(serialized).not.toMatch(/secret|api[_-]?key|password/i)
  })

  it('keys operations by idempotency key and candidate version', async () => {
    const dir = await tempDir()
    const outbox = new Outbox({ dir })
    const v1 = await outbox.enqueue(operation())
    const v2 = await outbox.enqueue(operation({ candidateVersion: 2 }))
    expect(v2.accepted).toBe(true)
    expect(v2.operationId).not.toBe(v1.operationId)
    expect((await outbox.status()).total).toBe(2)
    expect((await outbox.operationFor('candidate-1', 2))?.candidateVersion).toBe(2)
  })
})
