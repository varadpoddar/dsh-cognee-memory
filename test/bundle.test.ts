import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { exportScope, importBundle, readBundle } from '../src/cli/bundle.js'
import { MemoryError } from '../src/errors.js'
import { MemoryLedger } from '../src/memory/ledger.js'
import { makeScopeRef } from '../src/memory/scopes.js'
import type { RememberRequest } from '../src/memory/coordinator.js'
import type { CallerIdentity, Provenance, ScopeRef } from '../src/types.js'

const source = makeScopeRef('project', 'roundtrip-source')
const target = makeScopeRef('project', 'roundtrip-target')
const forbidden = makeScopeRef('project', 'not-allowed')

const provenance: Provenance = {
  kind: 'import',
  source: 'test',
  recordedAt: '2026-11-22T00:00:00.000Z',
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-bundle-'))
}

function seededLedger(): MemoryLedger {
  const ledger = new MemoryLedger({ filePath: join(tempDir(), 'ledger.jsonl') })
  ledger.recordWrite({
    recordId: 'mem-a1',
    scope: source,
    text: 'the launch code is cobalt-1234',
    semanticKey: 'launch-code',
    provenance,
    createdAt: '2026-11-22T00:00:00.000Z',
    sourceRefs: [{ sessionId: 'session-a', messageIndex: 3, producedAt: '2026-11-22T00:00:00.000Z' }],
  })
  ledger.recordWrite({
    recordId: 'mem-a2',
    scope: source,
    text: 'the deploy target is CT 103',
    semanticKey: 'deploy-target',
    provenance,
    createdAt: '2026-11-22T00:05:00.000Z',
  })
  ledger.recordWrite({
    recordId: 'mem-other',
    scope: makeScopeRef('project', 'unrelated'),
    text: 'not part of the export',
    provenance,
    createdAt: '2026-11-22T00:06:00.000Z',
  })
  return ledger
}

/** Fake coordinator: writes the ledger the way the real coordinator does. */
function fakeCoordinator(ledger: MemoryLedger, scope: ScopeRef): {
  readonly requests: RememberRequest[]
  readonly identity: CallerIdentity
  readonly coordinator: Parameters<typeof importBundle>[0]['coordinator']
} {
  const requests: RememberRequest[] = []
  return {
    requests,
    identity: { projectId: scope.id },
    coordinator: {
      async remember(request: RememberRequest) {
        requests.push(request)
        const recordId = `mem-import-${requests.length}`
        ledger.recordWrite({
          recordId,
          scope,
          text: request.text,
          ...(request.semanticKey === undefined ? {} : { semanticKey: request.semanticKey }),
          provenance: request.provenance,
          sourceRefs: request.sourceRefs ?? [],
          createdAt: '2026-11-22T01:00:00.000Z',
        })
        return { id: recordId, scope, createdAt: '2026-11-22T01:00:00.000Z', deduplicated: false }
      },
    } as unknown as Parameters<typeof importBundle>[0]['coordinator'],
  }
}

describe('bundle export', () => {
  it('writes a validated bundle with provenance, keys, and no cross-scope records', () => {
    const ledger = seededLedger()
    const outPath = join(tempDir(), 'bundle.jsonl')
    const result = exportScope({ ledger, scope: source, outPath })
    expect(result.count).toBe(2)
    expect(result.skippedSecrets).toBe(0)
    const parsed = readBundle(outPath)
    expect(parsed.header.type).toBe('bundle')
    expect(parsed.header.sourceScope).toEqual({ scope: 'project', id: 'roundtrip-source' })
    expect(parsed.records.map((record) => record.semanticKey)).toEqual(['launch-code', 'deploy-target'])
    expect(parsed.records[0]?.sourceRefs[0]?.messageIndex).toBe(3)
    expect(parsed.records[0]?.provenance.kind).toBe('import')
    const lines = readFileSync(outPath, 'utf8').trim().split('\n')
    expect(JSON.parse(lines[0] ?? '{}').count).toBe(2)
  })

  it('rejects a malformed or empty bundle', () => {
    const dir = tempDir()
    const missing = join(dir, 'missing.jsonl')
    expect(() => readBundle(missing)).toThrow(MemoryError)
    const empty = join(dir, 'empty.jsonl')
    writeFileSync(empty, '\n')
    expect(() => readBundle(empty)).toThrow(/empty/)
    const bad = join(dir, 'bad.jsonl')
    writeFileSync(bad, '{"type":"record"}\n')
    expect(() => readBundle(bad)).toThrow(/header missing/)
  })
})

describe('bundle import', () => {
  it('round-trips into a second scope, dedupes re-import, and marks conflicts', async () => {
    const ledger = seededLedger()
    const outPath = join(tempDir(), 'bundle.jsonl')
    exportScope({ ledger, scope: source, outPath })
    const { coordinator, identity } = fakeCoordinator(ledger, target)

    const dry = await importBundle({
      bundlePath: outPath,
      ledger,
      coordinator,
      identity,
      scope: target,
      allowedScopes: [target],
      apply: false,
    })
    expect(dry.imported).toBe(2)
    expect(ledger.recordsIn(target)).toHaveLength(0)

    const first = await importBundle({
      bundlePath: outPath,
      ledger,
      coordinator,
      identity,
      scope: target,
      allowedScopes: [target],
      apply: true,
    })
    expect(first.imported).toBe(2)
    expect(first.deduplicated).toBe(0)
    expect(ledger.recordsIn(target)).toHaveLength(2)

    const second = await importBundle({
      bundlePath: outPath,
      ledger,
      coordinator,
      identity,
      scope: target,
      allowedScopes: [target],
      apply: true,
    })
    expect(second.imported).toBe(0)
    expect(second.deduplicated).toBe(2)

    // A different fact under the same semantic key conflicts instead of overwriting.
    const conflictPath = join(tempDir(), 'conflict.jsonl')
    const lines = readFileSync(outPath, 'utf8').trim().split('\n')
    const header = JSON.parse(lines[0] ?? '{}')
    const records = lines.slice(1).map((line) => JSON.parse(line))
    const conflicting = { ...records[0], text: 'the launch code is cobalt-9999', recordId: 'mem-conflict-src' }
    writeFileSync(
      conflictPath,
      `${[header, conflicting].map((line) => JSON.stringify(line)).join('\n')}\n`,
    )
    const conflict = await importBundle({
      bundlePath: conflictPath,
      ledger,
      coordinator,
      identity,
      scope: target,
      allowedScopes: [target],
      apply: true,
    })
    expect(conflict.conflicts).toBe(1)
    expect(conflict.imported).toBe(0)
    expect(conflict.deduplicated).toBe(0)
    const annotated = ledger.recordsIn(target, { includeConflicts: true })
    expect(annotated.filter((entry) => entry.state === 'active')).toHaveLength(2)
    expect(annotated.filter((entry) => entry.state === 'conflict')).toHaveLength(1)
    expect(annotated.find((entry) => entry.state === 'conflict')?.conflictOf).toBe('mem-import-1')
  })

  it('refuses a target scope the importer cannot write', async () => {
    const ledger = seededLedger()
    const outPath = join(tempDir(), 'bundle.jsonl')
    exportScope({ ledger, scope: source, outPath })
    const { coordinator, identity } = fakeCoordinator(ledger, forbidden)
    await expect(
      importBundle({
        bundlePath: outPath,
        ledger,
        coordinator,
        identity,
        scope: forbidden,
        allowedScopes: [target],
        apply: true,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(ledger.recordsIn(forbidden)).toHaveLength(0)
  })

  it('refuses secret-bearing records and ignores the scope a bundle claims', async () => {
    const dir = tempDir()
    const body = JSON.stringify({
      version: 1,
      type: 'bundle',
      exportedAt: '2026-11-22T00:00:00.000Z',
      sourceScope: { scope: 'project', id: 'elsewhere' },
      count: 2,
      generator: 'dsh-cognee-memory',
    })
    const record = (rid: string, text: string) =>
      JSON.stringify({
        version: 1,
        type: 'record',
        recordId: rid,
        scope: { scope: 'project', id: 'elsewhere' },
        text,
        semanticKey: rid,
        confidence: 0.6,
        createdAt: '2026-11-22T00:00:00.000Z',
        provenance,
        sourceRefs: [],
      })
    const path = join(dir, 'smuggle.jsonl')
    writeFileSync(
      path,
      `${[body, record('mem-safe', 'the launch code is cobalt-1234'), record('mem-secret', `token sk-${'a'.repeat(32)}`)].join('\n')}\n`,
    )
    const ledger = new MemoryLedger({ filePath: join(dir, 'ledger.jsonl') })
    const { coordinator, identity } = fakeCoordinator(ledger, target)
    const result = await importBundle({
      bundlePath: path,
      ledger,
      coordinator,
      identity,
      scope: target,
      allowedScopes: [target],
      apply: true,
    })
    expect(result.refused).toBe(1)
    expect(result.imported).toBe(1)
    expect(ledger.recordsIn(target).map((entry) => entry.semanticKey)).toEqual(['mem-safe'])
  })
})
