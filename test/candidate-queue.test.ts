import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CandidateQueue } from '../src/memory/candidate-queue.js'
import type { MemoryCandidate } from '../src/memory/extraction.js'
import { makeScopeRef } from '../src/memory/scopes.js'

let dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cognee-queue-'))
  dirs.push(dir)
  return dir
}

function candidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  const idempotencyKey = overrides.idempotencyKey ?? 'a'.repeat(64)
  return {
    id: overrides.id ?? `mem-${idempotencyKey.slice(0, 32)}`,
    semanticKey: 'release-codename',
    principalId: 'p1',
    scope: makeScopeRef('project', 'e2e'),
    content: 'the release codename is amber-otter-7731',
    sourceRefs: [{ sessionId: 's1', turn: 1, eventType: 'user/message', producedAt: '2026-01-01T00:00:00.000Z' }],
    verificationState: 'user_asserted',
    sensitivity: 'normal',
    createdAt: '2026-01-01T00:00:00.000Z',
    idempotencyKey,
    operation: 'remember',
    ...overrides,
  }
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

describe('CandidateQueue', () => {
  it('enqueues and replays pending candidates from disk', async () => {
    const dir = await tempDir()
    const queue = new CandidateQueue({ dir })
    expect(await queue.enqueue(candidate())).toEqual({ accepted: true })
    const reopened = new CandidateQueue({ dir })
    expect((await reopened.pending()).map((item) => item.id)).toEqual([candidate().id])
  })

  it('deduplicates by idempotency key, including completed work', async () => {
    const dir = await tempDir()
    const queue = new CandidateQueue({ dir })
    await queue.enqueue(candidate())
    expect(await queue.enqueue(candidate())).toEqual({ accepted: false, reason: 'duplicate' })
    await queue.drain(async () => ({ status: 'ingested' }))
    expect(await queue.enqueue(candidate())).toEqual({ accepted: false, reason: 'duplicate' })
  })

  it('does not let a failed candidate block the next one', async () => {
    const dir = await tempDir()
    const queue = new CandidateQueue({ dir })
    await queue.enqueue(candidate({ idempotencyKey: 'b'.repeat(64) }))
    await queue.enqueue(candidate({ idempotencyKey: 'c'.repeat(64) }))
    const result = await queue.drain(async (item) => {
      if (item.idempotencyKey.startsWith('b')) throw new Error('ingest failed')
      return { status: 'ingested' }
    })
    expect(result).toMatchObject({ processed: 2, ingested: 1, failed: 1 })
    expect(await queue.status()).toMatchObject({ queued: 0, ingested: 1, failed: 1 })
  })

  it('records forget results separately from ingested facts', async () => {
    const dir = await tempDir()
    const queue = new CandidateQueue({ dir })
    await queue.enqueue(candidate({ operation: 'forget' }))
    await queue.drain(async () => ({ status: 'forgotten' }))
    expect(await queue.status()).toMatchObject({ queued: 0, forgotten: 1, ingested: 0 })
  })

  it('refuses secret-bearing content before writing', async () => {
    const dir = await tempDir()
    const queue = new CandidateQueue({ dir })
    const secret = candidate({
      content: 'the API key is sk-abcdefghijklmnopqrstuvwxyz012345',
    })
    expect(await queue.enqueue(secret)).toEqual({ accepted: false, reason: 'secret' })
    await expect(fs.readFile(queue.filePath, 'utf8')).rejects.toThrow()
  })

  it('skips corrupt JSONL lines instead of failing replay', async () => {
    const dir = await tempDir()
    const queue = new CandidateQueue({ dir })
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(queue.filePath, `${JSON.stringify({ type: 'candidate', candidate: candidate() })}\n{broken\n`)
    expect((await queue.pending()).map((item) => item.id)).toEqual([candidate().id])
  })

  it('enforces the pending cap', async () => {
    const dir = await tempDir()
    const queue = new CandidateQueue({ dir, maxPending: 1 })
    expect((await queue.enqueue(candidate({ idempotencyKey: 'd'.repeat(64) }))).accepted).toBe(true)
    expect(await queue.enqueue(candidate({ idempotencyKey: 'e'.repeat(64) }))).toEqual({
      accepted: false,
      reason: 'full',
    })
  })

  it('reports stable status counts and writes mode 0600', async () => {
    const dir = await tempDir()
    const queue = new CandidateQueue({ dir })
    await queue.enqueue(candidate())
    const stat = await fs.stat(queue.filePath)
    expect(stat.mode & 0o777).toBe(0o600)
    expect(await queue.status()).toMatchObject({ queued: 1, total: 1, ingested: 0 })
  })
})
