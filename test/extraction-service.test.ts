import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config/schema.js'
import { ExtractionService } from '../src/memory/extraction-service.js'
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
