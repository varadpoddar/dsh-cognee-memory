import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LEDGER_MAX_TEXT_CHARS,
  MemoryLedger,
  confidenceForProvenance,
  ledgerRecordId,
} from '../src/memory/ledger.js'
import { makeScopeRef } from '../src/memory/scopes.js'
import { findSecrets } from '../src/security/redaction.js'
import type { Provenance } from '../src/types.js'

const scope = makeScopeRef('project', 'ledger-demo')
const other = makeScopeRef('project', 'ledger-other')

function provenance(kind: Provenance['kind'] = 'user_explicit'): Provenance {
  return { kind, source: 'test', recordedAt: '2026-11-22T00:00:00.000Z' }
}

function tempLedger(): MemoryLedger {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ledger-'))
  return new MemoryLedger({ filePath: join(dir, 'ledger.jsonl') })
}

describe('memory ledger', () => {
  it('round-trips a write and folds supersession', () => {
    const ledger = tempLedger()
    ledger.recordWrite({
      recordId: 'mem-1',
      scope,
      text: 'the launch code is cobalt-1234',
      semanticKey: 'launch-code',
      provenance: provenance(),
      createdAt: '2026-11-22T00:00:00.000Z',
    })
    ledger.recordWrite({
      recordId: 'mem-2',
      scope,
      text: 'the launch code is cobalt-9999',
      semanticKey: 'launch-code',
      provenance: provenance(),
      createdAt: '2026-11-22T00:10:00.000Z',
      supersedes: 'mem-1',
    })
    ledger.markSuperseded('mem-1', 'mem-2')

    expect(ledger.recordsIn(scope).map((entry) => entry.recordId)).toEqual(['mem-2'])
    expect(ledger.folded().map((entry) => `${entry.recordId}:${entry.state}`)).toEqual([
      'mem-1:superseded',
      'mem-2:active',
    ])
    expect(ledger.findBySemanticKey(scope, 'launch-code')?.recordId).toBe('mem-2')
    expect(ledger.recordsIn(other)).toEqual([])
    expect(ledger.findBySemanticKey(scope, 'launch-code')?.confidence).toBeCloseTo(0.95)
  })

  it('redacts secrets before persisting and marks the entry', () => {
    const ledger = tempLedger()
    const secret = `sk-${'a'.repeat(32)}`
    ledger.recordWrite({
      recordId: 'mem-secret',
      scope,
      text: `the token is ${secret}`,
      semanticKey: 'token',
      provenance: provenance(),
      createdAt: '2026-11-22T00:00:00.000Z',
    })
    const entry = ledger.findBySemanticKey(scope, 'token')
    expect(entry?.redacted).toBe(true)
    expect(findSecrets(entry?.text ?? '')).toEqual([])
    expect(entry?.text).not.toContain(secret)
  })

  it('clips long text and skips corrupt lines', () => {
    const ledger = tempLedger()
    ledger.recordWrite({
      recordId: 'mem-long',
      scope,
      text: 'x'.repeat(LEDGER_MAX_TEXT_CHARS + 500),
      semanticKey: 'long',
      provenance: provenance(),
      createdAt: '2026-11-22T00:00:00.000Z',
    })
    writeFileSync(ledger.filePath, `${'not json'}\n`, { flag: 'a' })
    expect(ledger.findBySemanticKey(scope, 'long')?.text.length).toBe(LEDGER_MAX_TEXT_CHARS)
    expect(ledger.all().length).toBe(1)
  })

  it('derives confidence from provenance kind and record ids deterministically', () => {
    expect(confidenceForProvenance('user_explicit')).toBe(0.95)
    expect(confidenceForProvenance('import')).toBe(0.6)
    expect(ledgerRecordId(scope, 'launch-code', 'x')).toBe(ledgerRecordId(scope, 'launch-code', 'x'))
    expect(ledgerRecordId(scope, 'launch-code', 'x')).not.toBe(ledgerRecordId(other, 'launch-code', 'x'))
  })
})
