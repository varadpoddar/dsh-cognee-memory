import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config/schema.js'
import { MemoryError } from '../src/errors.js'
import { CandidateQueue } from '../src/memory/candidate-queue.js'
import { ExtractionService } from '../src/memory/extraction-service.js'
import { Outbox } from '../src/memory/outbox.js'
import type { CallerIdentity, RememberResult } from '../src/types.js'

let dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cognee-extract-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

function harness(dir: string) {
  const remembered: Array<{ text: string; scope?: string }> = []
  const forgotten: string[] = []
  const config = parseConfig({
    scopeDefaults: { projectId: 'e2e' },
    extraction: { queue: { dir } },
  })
  const service = new ExtractionService({
    config,
    coordinator: {
      async resolveIdentity(identity: CallerIdentity) {
        return { ...identity, principalId: 'p1' }
      },
      async remember(request) {
        remembered.push({ text: request.text, ...(request.scopeName === undefined ? {} : { scope: request.scopeName }) })
        return { id: 'mem-x', scope: { scope: 'project', id: 'x' }, createdAt: 'now', deduplicated: false } as RememberResult
      },
      async forgetByText(request) {
        forgotten.push(request.text)
        return { forgotten: 1, ids: ['mem-old'] }
      },
    },
  })
  return { service, remembered, forgotten, config }
}

describe('ExtractionService', () => {
  it('extracts, queues, and ingests an explicit memory without any tool call', async () => {
    const dir = await tempDir()
    const h = harness(dir)
    await h.service.handleTurn({
      sessionId: 'session-a',
      turn: 1,
      messages: [{ text: 'Remember that the release codename is amber-otter-7731.' }],
    })
    expect(h.remembered.map((item) => item.text)).toEqual([
      'the release codename is amber-otter-7731',
    ])
    expect(h.remembered[0]?.scope).toBe('project')
    const status = await h.service.status()
    expect(status.queue).toMatchObject({ queued: 0, ingested: 1 })
    expect(status.lastCandidates[0]).toMatchObject({
      semanticKey: 'release-codename',
      principalId: 'p1',
    })
  })

  it('handles an explicit forget command through the deterministic path', async () => {
    const dir = await tempDir()
    const h = harness(dir)
    await h.service.handleTurn({
      sessionId: 'session-a',
      turn: 2,
      messages: [{ text: 'Forget the release codename.' }],
    })
    expect(h.forgotten).toEqual(['the release codename'])
    expect(await h.service.status()).toMatchObject({ queue: { forgotten: 1 } })
  })

  it('does not duplicate work when the same committed message is replayed', async () => {
    const dir = await tempDir()
    const first = harness(dir)
    const turn = {
      sessionId: 'session-a',
      turn: 1,
      messages: [{ text: 'Remember that the release codename is amber-otter-7731.' }],
    }
    await first.service.handleTurn(turn)
    const second = harness(dir)
    await second.service.handleTurn(turn)
    expect(first.remembered).toHaveLength(1)
    expect(second.remembered).toHaveLength(0)
    expect(await second.service.status()).toMatchObject({ queue: { ingested: 1, queued: 0 } })
  })

  it('refuses to write when there is no authenticated principal', async () => {
    const dir = await tempDir()
    const config = parseConfig({ extraction: { queue: { dir } } })
    let remembered = 0
    const service = new ExtractionService({
      config,
      coordinator: {
        async resolveIdentity(identity) {
          return identity
        },
        async remember() {
          remembered += 1
          throw new Error('must not be called')
        },
        async forgetByText() {
          return { forgotten: 0, ids: [] }
        },
      },
    })
    await service.handleTurn({
      sessionId: 'session-a',
      turn: 1,
      messages: [{ text: 'Remember that the flag is on.' }],
    })
    expect(remembered).toBe(0)
    expect((await service.status()).lastError).toMatch(/principal/)
  })

  it('does nothing when extraction is disabled', async () => {
    const dir = await tempDir()
    const config = parseConfig({ extraction: { enabled: false, queue: { dir } } })
    let remembered = 0
    const service = new ExtractionService({
      config,
      coordinator: {
        async resolveIdentity(identity) {
          return { ...identity, principalId: 'p1' }
        },
        async remember() {
          remembered += 1
          throw new Error('must not be called')
        },
        async forgetByText() {
          return { forgotten: 0, ids: [] }
        },
      },
    })
    await service.handleTurn({
      sessionId: 'session-a',
      turn: 1,
      messages: [{ text: 'Remember that the flag is on.' }],
    })
    expect(remembered).toBe(0)
  })
})

describe('ExtractionService outbox integration', () => {
  function outboxHarness(dir: string, overrides: {
    autoWrite?: boolean
    remember?: (text: string) => Promise<RememberResult>
    outbox?: Record<string, unknown>
  } = {}) {
    const remembered: string[] = []
    const config = parseConfig({
      scopeDefaults: { projectId: 'e2e' },
      extraction: { queue: { dir } },
      ...(overrides.autoWrite === undefined ? {} : { autoWrite: overrides.autoWrite }),
      ...(overrides.outbox === undefined ? {} : { outbox: overrides.outbox }),
    })
    const service = new ExtractionService({
      config,
      coordinator: {
        async resolveIdentity(identity: CallerIdentity) {
          return { ...identity, principalId: 'p1' }
        },
        async remember(request) {
          remembered.push(request.text)
          if (overrides.remember !== undefined) return overrides.remember(request.text)
          return {
            id: 'mem-x',
            scope: { scope: 'project', id: 'x' },
            createdAt: 'now',
            deduplicated: false,
          } as RememberResult
        },
        async forgetByText() {
          return { forgotten: 1, ids: ['mem-old'] }
        },
      },
    })
    return { service, remembered, config }
  }

  it('records a completed write with its Cognee data reference', async () => {
    const dir = await tempDir()
    const h = outboxHarness(dir)
    await h.service.handleTurn({
      sessionId: 'session-a',
      turn: 1,
      messages: [{ text: 'Remember that the deploy target is CT 103.' }],
    })
    const status = await h.service.status()
    expect(status.outbox.total).toBe(1)
    expect(status.outbox.complete).toBe(1)
    expect(status.outbox.operations[0]).toMatchObject({
      operation: 'remember',
      dataset: 'dsh-project-e2e',
      state: 'complete',
      attempts: 1,
    })
    expect(status.outbox.operations[0]?.dataRef).toMatch(/^cognee:dsh-project-e2e#mem-x$/)
    expect(status.queue).toMatchObject({ queued: 0, ingested: 1 })
  })

  it('stops new extraction when autoWrite is off but still drains accepted work', async () => {
    const dir = await tempDir()
    const first = outboxHarness(dir)
    await first.service.handleTurn({
      sessionId: 'session-a',
      turn: 1,
      messages: [{ text: 'Remember that the deploy target is CT 103.' }],
    })
    expect(first.remembered).toHaveLength(1)

    // A queued candidate accepted earlier must not be lost when writes are off.
    const second = outboxHarness(dir, { autoWrite: false })
    await second.service.handleTurn({
      sessionId: 'session-b',
      turn: 1,
      messages: [{ text: 'Remember that the backup host is CT 104.' }],
    })
    expect(second.remembered).toHaveLength(0)
    const status = await second.service.status()
    expect(status.autoWrite).toBe(false)
    expect(status.queue).toMatchObject({ queued: 0, ingested: 1 })
  })

  it('recovers a candidate and expired processing lease left by a previous process', async () => {
    const dir = await tempDir()
    const queue = new CandidateQueue({ dir })
    const candidate = {
      id: 'mem-recover',
      semanticKey: 'deploy-target',
      principalId: 'p1',
      scope: { scope: 'project', id: 'e2e' } as const,
      content: 'the deploy target is CT 103',
      sourceRefs: [
        {
          sessionId: 'session-a',
          turn: 1,
          eventType: 'user/message' as const,
          producedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      verificationState: 'user_asserted' as const,
      sensitivity: 'normal' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
      idempotencyKey: 'candidate-recovery',
      operation: 'remember' as const,
    }
    await queue.enqueue(candidate)
    const outbox = new Outbox({ dir, leaseMs: 1_000, now: () => 10_000 })
    const enqueued = await outbox.enqueue({
      idempotencyKey: candidate.idempotencyKey,
      dataset: 'dsh-project-e2e',
      operation: 'remember',
      content: candidate.content,
    })
    // The previous process died between sending the write and recording it.
    await fs.appendFile(
      path.join(dir, 'outbox.jsonl'),
      `${JSON.stringify({
        type: 'operation',
        operation: {
          operationId: enqueued.operationId,
          idempotencyKey: candidate.idempotencyKey,
          dataset: 'dsh-project-e2e',
          operation: 'remember',
          content: candidate.content,
          candidateVersion: 1,
          state: 'processing',
          attempts: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      })}\n`,
    )

    const replay = outboxHarness(dir, { outbox: { leaseMs: 1_000 } })
    await replay.service.start()
    expect(replay.remembered).toEqual(['the deploy target is CT 103'])
    const status = await replay.service.status()
    expect(status.queue).toMatchObject({ ingested: 1, queued: 0 })
    expect(status.outbox.complete).toBe(1)
  })

  it('never retries a permanent authorization failure and records it truthfully', async () => {
    const dir = await tempDir()
    let calls = 0
    const h = outboxHarness(dir, {
      remember: async () => {
        calls += 1
        throw new MemoryError('FORBIDDEN', 'not allowed', { retryable: false })
      },
    })
    await h.service.handleTurn({
      sessionId: 'session-a',
      turn: 1,
      messages: [{ text: 'Remember that the deploy target is CT 103.' }],
    })
    expect(calls).toBe(1)
    const status = await h.service.status()
    expect(status.outbox.failed).toBe(1)
    expect(status.outbox.operations[0]?.reason).toBe('FORBIDDEN')
    expect(status.queue).toMatchObject({ failed: 1, queued: 0 })
  })

  it('retries a transient write failure with backoff and completes', async () => {
    const dir = await tempDir()
    let calls = 0
    const h = outboxHarness(dir, {
      outbox: { baseBackoffMs: 10, maxAttempts: 3 },
      remember: async () => {
        calls += 1
        if (calls === 1) throw new MemoryError('BACKEND', 'flaky', { retryable: true })
        return {
          id: 'mem-y',
          scope: { scope: 'project', id: 'x' },
          createdAt: 'now',
          deduplicated: false,
        } as RememberResult
      },
    })
    await h.service.handleTurn({
      sessionId: 'session-a',
      turn: 1,
      messages: [{ text: 'Remember that the deploy target is CT 103.' }],
    })
    expect(calls).toBe(2)
    const status = await h.service.status()
    expect(status.outbox.complete).toBe(1)
    expect(status.queue).toMatchObject({ ingested: 1 })
  })
})
