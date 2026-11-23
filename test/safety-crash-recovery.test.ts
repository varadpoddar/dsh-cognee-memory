import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Outbox, type OutboxOperation, type OutboxSinkResult } from '../src/memory/outbox.js'

/**
 * Restart safety for the durable write outbox (Workstream C, tests 23–26).
 *
 * The live crash matrix killed a DSH process while a write was held between
 * "durably queued" and "acknowledged by Cognee"; the backend ended with exactly
 * one record. These cases pin the two halves of that property offline: a
 * completed operation is never replayed after a restart, and an operation that
 * was queued but never attempted is drained exactly once.
 *
 * The outbox is append-only on disk, so a "restart" is just a second instance
 * pointed at the same directory.
 */
const directories: string[] = []

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-safety-outbox-'))
  directories.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of directories.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

function queued() {
  return {
    idempotencyKey: 'crashed-write',
    dataset: 'dsh-project-safety-crash',
    operation: 'remember' as const,
    content: 'the crash marker is C23-0001 and it must persist',
    candidateVersion: 1,
  }
}

async function complete(_operation: OutboxOperation): Promise<OutboxSinkResult> {
  return { status: 'complete', dataRef: 'cognee:dsh-project-safety-crash#record-1' }
}

describe('outbox restart safety', () => {
  it('does not replay a completed operation after a restart', async () => {
    const dir = await tempDir()
    const first = new Outbox({ dir })
    await first.enqueue(queued())
    const sink = vi.fn(complete)
    expect((await first.drain(sink)).completed).toBe(1)

    const restarted = new Outbox({ dir })
    expect((await restarted.recover()).recovered).toBe(0)
    const replay = vi.fn(complete)
    expect(await restarted.drain(replay)).toMatchObject({ processed: 0, completed: 0 })
    expect(replay).not.toHaveBeenCalled()
    expect(await restarted.status()).toMatchObject({ complete: 1, total: 1 })
    expect((await restarted.operationFor('crashed-write'))?.dataRef).toBe(
      'cognee:dsh-project-safety-crash#record-1',
    )
  })

  it('drains a durably queued operation exactly once after a restart', async () => {
    const dir = await tempDir()
    const before = new Outbox({ dir })
    await before.enqueue(queued())
    // No drain: the process died after the durable enqueue and before the write.
    expect(await before.status()).toMatchObject({ pending: 1 })

    const restarted = new Outbox({ dir })
    expect((await restarted.recover()).recovered).toBe(0)
    const sink = vi.fn(complete)
    expect(await restarted.drain(sink)).toMatchObject({ processed: 1, completed: 1 })
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink.mock.calls[0]?.[0]?.content).toBe(queued().content)

    const afterRestart = new Outbox({ dir })
    const secondSink = vi.fn(complete)
    expect(await afterRestart.drain(secondSink)).toMatchObject({ processed: 0 })
    expect(secondSink).not.toHaveBeenCalled()
    expect(await afterRestart.status()).toMatchObject({ complete: 1, total: 1 })
  })

  it('re-queues a crashed in-flight operation once, not twice', async () => {
    const dir = await tempDir()
    const outbox = new Outbox({ dir, leaseMs: 1_000, now: () => 10_000 })
    const enqueued = await outbox.enqueue(queued())
    // The exact on-disk aftermath of a process killed between "sent" and "ack".
    const crashed = {
      type: 'operation',
      operation: {
        operationId: enqueued.operationId,
        idempotencyKey: 'crashed-write',
        dataset: 'dsh-project-safety-crash',
        operation: 'remember',
        content: queued().content,
        candidateVersion: 1,
        state: 'processing',
        attempts: 1,
        createdAt: new Date(5_000).toISOString(),
        updatedAt: new Date(5_000).toISOString(),
      },
    }
    await fs.appendFile(path.join(dir, 'outbox.jsonl'), `${JSON.stringify(crashed)}\n`)

    const sink = vi.fn(complete)
    expect((await outbox.recover()).recovered).toBe(1)
    expect((await outbox.recover()).recovered).toBe(0)
    expect(sink).not.toHaveBeenCalled()
    expect(await outbox.drain(sink)).toMatchObject({ processed: 1, completed: 1 })
    const stored = await outbox.operationFor('crashed-write')
    expect(stored).toMatchObject({ state: 'complete', attempts: 2 })
  })
})
