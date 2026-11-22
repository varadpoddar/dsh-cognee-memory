import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  applyHistoryImport,
  emptyImportState,
  loadImportState,
  planHistoryImport,
  resolveImportStatePath,
} from '../src/cli/history-import.js'
import { discoverTranscripts, readTranscript } from '../src/cli/transcript.js'
import { makeScopeRef, scopeKey } from '../src/memory/scopes.js'
import type { RememberRequest } from '../src/memory/coordinator.js'
import type { ScopeRef } from '../src/types.js'

const sessionId = 'session-backfill-test'
const scope = makeScopeRef('project', 'backfill-demo')

function frame(event: unknown): Buffer {
  return zstdCompressSync(`${JSON.stringify(event)}\n`)
}

function userMessage(seq: number, time: number, text: string): Record<string, unknown> {
  return {
    type: 'user/message',
    seq,
    time,
    data: { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user' },
  }
}

/** One real concatenated-frame zstd transcript: header frame + one batch frame. */
function fixture(): { sessionsDir: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-backfill-'))
  const dir = join(root, 'sessions', 'proj', `session-${sessionId}`)
  mkdirSync(dir, { recursive: true })
  const base = 1_795_370_000_000
  const events: unknown[] = [
    { type: 'session', version: 4, id: `session-${sessionId}`, createdAt: base, cwd: '/root' },
    userMessage(3, base + 1_000, 'remember that the launch code is cobalt-1234'),
    { type: 'assistant/message', seq: 4, time: base + 2_000, data: { content: [{ type: 'text', text: 'noted' }] } },
    userMessage(5, base + 3_000, 'Current runtime context. This snapshot supersedes earlier ones.'),
    userMessage(6, base + 4_000, `remember that the api key is sk-${'a'.repeat(32)}`),
    {
      type: 'user/message',
      seq: 7,
      time: base + 5_000,
      data: { content: [{ type: 'reasoning', text: 'hidden chain of thought' }], source: { kind: 'assistant' } },
    },
    userMessage(8, base + 6_000, 'actually the launch code is cobalt-9999'),
  ]
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(
    file,
    Buffer.concat([frame(events[0]), frame(events[1]), ...events.slice(2).map((event) => frame(event))]),
  )
  return { sessionsDir: join(root, 'sessions'), file }
}

describe('transcript decoding', () => {
  it('decodes every concatenated zstd frame and keeps only committed human text', () => {
    const { sessionsDir, file } = fixture()
    expect(discoverTranscripts(sessionsDir)).toEqual([file])
    const transcript = readTranscript(file)
    expect(transcript.frames).toBe(7)
    expect(transcript.torn).toBe(false)
    expect(transcript.sessionId).toBe(`session-${sessionId}`)
    expect(transcript.messages.map((message) => message.messageIndex)).toEqual([3, 6, 8])
    expect(transcript.skips.synthetic).toBe(1)
    expect(transcript.skips.notHuman).toBe(1)
  })
})

describe('import-history plan and apply', () => {
  it('plans explicit facts only, reports redaction hits, and is idempotent', async () => {
    const { sessionsDir } = fixture()
    const stateFile = join(mkdtempSync(join(tmpdir(), 'dsh-state-')), 'state.json')
    const plan = planHistoryImport({ sessionsDir, scope, principalId: 'principal-a' })

    expect(plan.sessions).toBe(1)
    expect(plan.messages).toBe(3)
    expect(plan.candidates).toHaveLength(2)
    expect(plan.skipped.secrets).toBe(1)
    expect(plan.skipped.synthetic).toBe(1)
    expect(plan.namespaces).toEqual([scopeKey(scope)])
    expect(plan.byOperation).toEqual({ remember: 2 })
    expect(plan.candidates.map((entry) => entry.candidate.semanticKey)).toEqual(['launch-code', 'launch-code'])
    // The fact, never the whole transcript message.
    expect(plan.candidates[0]?.candidate.content).toBe('the launch code is cobalt-1234')
    expect(plan.candidates[1]?.candidate.supersedes).toBe(plan.candidates[0]?.candidate.id)

    const writes: RememberRequest[] = []
    const coordinator = {
      async resolveIdentity(identity: Record<string, unknown>) {
        return identity
      },
      async remember(request: RememberRequest) {
        writes.push(request)
        const recordId = `mem-backfill-${writes.length}`
        return {
          id: recordId,
          scope: request.identity.projectId === undefined ? scope : (scope as ScopeRef),
          createdAt: request.provenance.recordedAt,
          deduplicated: false,
        }
      },
    } as unknown as Parameters<typeof applyHistoryImport>[0]['coordinator']

    const first = await applyHistoryImport({ plan, coordinator, stateFile })
    expect(first.ingested).toBe(2)
    expect(first.failed).toBe(0)
    expect(writes[0]?.provenance.kind).toBe('session_event')
    expect(writes[0]?.identity.projectId).toBe('backfill-demo')
    expect(writes[0]?.sourceRefs?.[0]?.messageIndex).toBe(3)
    // Supersession is resolved to the durable record id, not the candidate id.
    expect(writes[1]?.supersedes).toBe('mem-backfill-1')
    expect(Object.keys(loadImportState(stateFile).records)).toHaveLength(2)

    const replanned = planHistoryImport({
      sessionsDir,
      scope,
      principalId: 'principal-a',
      state: loadImportState(stateFile),
    })
    expect(replanned.alreadyImported).toBe(2)
    expect(replanned.pending).toHaveLength(0)
  })

  it('reports an empty state file and a stable default path', () => {
    const state = emptyImportState()
    expect(state.version).toBe(1)
    expect(state.records).toEqual({})
    expect(resolveImportStatePath({ DSH_HOME: '/tmp/home' })).toBe(
      '/tmp/home/plugins/cognee-memory/import-history.state.json',
    )
  })
})
