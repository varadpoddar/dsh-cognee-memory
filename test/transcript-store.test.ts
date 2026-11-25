import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TRANSCRIPTS_DIR_ENV,
  TranscriptStore,
  resolveTranscriptsDir,
  transcriptHash,
  transcriptPathFor,
} from '../src/memory/transcript-store.js'
import { MemoryError } from '../src/errors.js'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function storeIn(): TranscriptStore {
  const directory = mkdtempSync(join(tmpdir(), 'transcript-store-'))
  directories.push(directory)
  return new TranscriptStore({ dir: directory })
}

function fileLines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '')
}

describe('transcript store layout', () => {
  it('defaults under the plugin state dir and honours the env override', () => {
    expect(resolveTranscriptsDir({ DSH_HOME: '/tmp/dsh-home' })).toBe(
      '/tmp/dsh-home/plugins/cognee-memory/transcripts',
    )
    expect(resolveTranscriptsDir({ [TRANSCRIPTS_DIR_ENV]: '/tmp/custom' })).toBe('/tmp/custom')
    expect(transcriptPathFor('session-1', '/tmp/t')).toBe('/tmp/t/session-1.jsonl')
    expect(() => transcriptPathFor('..', '/tmp/t')).toThrow(MemoryError)
  })
})

describe('transcript store append and read', () => {
  it('stores both sides verbatim with canonical char offsets', () => {
    const store = storeIn()
    const user = store.appendTurn({
      sessionId: 's1',
      turnIndex: 0,
      role: 'user',
      text: 'hello\nworld',
      timestamp: '2026-01-02T03:04:05.000Z',
    })
    const assistant = store.appendTurn({
      sessionId: 's1',
      turnIndex: 0,
      role: 'assistant',
      text: 'hi there',
      timestamp: '2026-01-02T03:04:06.000Z',
    })
    expect(user.duplicate).toBe(false)
    expect(user.row.text).toBe('hello\nworld')
    expect(user.row.char_start).toBe(0)
    expect(user.row.char_end).toBe('hello\nworld'.length)
    expect(user.row.content_hash).toBe(transcriptHash('hello\nworld'))
    expect(assistant.row.char_start).toBe('hello\nworld'.length + 2)
    expect(assistant.row.char_end).toBe('hello\nworld'.length + 2 + 'hi there'.length)
    expect(store.readTurn('s1', 0, 'user')?.text).toBe('hello\nworld')
    expect(store.readTurn('s1', 0, 'assistant')?.text).toBe('hi there')
    const range = store.readRange('s1', { turnStart: 0, turnEnd: 0 })
    expect(range?.text).toBe('hello\nworld\n\nhi there')
    expect(range?.contentHash).toBe(transcriptHash('hello\nworld\n\nhi there'))
    expect(range?.charStart).toBe(0)
    expect(range?.charEnd).toBe('hello\nworld\n\nhi there'.length)
  })

  it('never truncates a long message', () => {
    const store = storeIn()
    const text = 'x'.repeat(20_000)
    store.appendTurn({ sessionId: 's-long', turnIndex: 0, role: 'user', text })
    expect(store.readTurn('s-long', 0)?.text).toBe(text)
    expect(store.readRange('s-long', { turnStart: 0, turnEnd: 0 })?.text).toBe(text)
  })

  it('is idempotent for an identical row and refuses a conflicting rewrite', () => {
    const store = storeIn()
    const first = store.appendTurn({ sessionId: 's1', turnIndex: 0, role: 'user', text: 'same' })
    const again = store.appendTurn({ sessionId: 's1', turnIndex: 0, role: 'user', text: 'same' })
    expect(again.duplicate).toBe(true)
    expect(again.row.content_hash).toBe(first.row.content_hash)
    const path = transcriptPathFor('s1', store.dir)
    expect(fileLines(path)).toHaveLength(1)
    expect(() =>
      store.appendTurn({ sessionId: 's1', turnIndex: 0, role: 'user', text: 'edited' }),
    ).toThrow(MemoryError)
  })

  it('rejects out-of-order turns instead of rewriting history', () => {
    const store = storeIn()
    store.appendTurn({ sessionId: 's1', turnIndex: 2, role: 'user', text: 'later' })
    expect(() =>
      store.appendTurn({ sessionId: 's1', turnIndex: 1, role: 'user', text: 'earlier' }),
    ).toThrow(MemoryError)
    store.appendTurn({ sessionId: 's1', turnIndex: 2, role: 'assistant', text: 'answer' })
    expect(() =>
      store.appendTurn({ sessionId: 's1', turnIndex: 2, role: 'user', text: 'too late' }),
    ).toThrow(MemoryError)
  })

  it('rejects empty text, bad turn indices, bad roles, and bad timestamps', () => {
    const store = storeIn()
    expect(() => store.appendTurn({ sessionId: 's1', turnIndex: 0, role: 'user', text: '' })).toThrow(MemoryError)
    expect(() => store.appendTurn({ sessionId: 's1', turnIndex: -1, role: 'user', text: 'x' })).toThrow(MemoryError)
    expect(() => store.appendTurn({ sessionId: 's1', turnIndex: 0.5, role: 'user', text: 'x' })).toThrow(MemoryError)
    expect(() =>
      store.appendTurn({ sessionId: 's1', turnIndex: 0, role: 'system' as never, text: 'x' }),
    ).toThrow(MemoryError)
    expect(() =>
      store.appendTurn({ sessionId: 's1', turnIndex: 0, role: 'user', text: 'x', timestamp: 'not-a-date' }),
    ).toThrow(MemoryError)
  })

  it('survives a restart with recomputed offsets', () => {
    const directory = mkdtempSync(join(tmpdir(), 'transcript-store-'))
    directories.push(directory)
    const first = new TranscriptStore({ dir: directory })
    first.appendTurn({ sessionId: 's1', turnIndex: 0, role: 'user', text: 'alpha' })
    first.appendTurn({ sessionId: 's1', turnIndex: 1, role: 'assistant', text: 'beta' })
    const reopened = new TranscriptStore({ dir: directory })
    const rows = reopened.readTurns('s1', 0, 1)
    expect(rows.map((row) => row.text)).toEqual(['alpha', 'beta'])
    expect(rows[1]?.char_start).toBe('alpha'.length + 2)
    expect(rows[0]?.session_id).toBe('s1')
  })

  it('tolerates corruption: garbage and torn lines are skipped, appends continue', () => {
    const store = storeIn()
    store.appendTurn({ sessionId: 's1', turnIndex: 0, role: 'user', text: 'good one' })
    const path = transcriptPathFor('s1', store.dir)
    writeFileSync(path, `${readFileSync(path, 'utf8')}not json\n{"session_id":"s1","turn_index":9\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    const rows = store.readTurns('s1', 0, 99)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.text).toBe('good one')
    expect(rows[0]?.char_start).toBe(0)
    const appended = store.appendTurn({ sessionId: 's1', turnIndex: 1, role: 'assistant', text: 'good two' })
    expect(appended.duplicate).toBe(false)
    expect(store.readRange('s1', { turnStart: 0, turnEnd: 1 })?.text).toBe(
      'good one\n\ngood two',
    )
  })

  it('resolves a char window inside a turn range exactly', () => {
    const store = storeIn()
    store.appendTurn({ sessionId: 's1', turnIndex: 0, role: 'user', text: 'hello world' })
    store.appendTurn({ sessionId: 's1', turnIndex: 1, role: 'assistant', text: 'goodbye' })
    const window = store.readRange('s1', { turnStart: 0, turnEnd: 1, charStart: 6, charEnd: 11 })
    expect(window?.text).toBe('world')
    expect(window?.charStart).toBe(6)
    expect(window?.charEnd).toBe(11)
    expect(window?.contentHash).toBe(transcriptHash('world'))
    const empty = store.readRange('s1', { turnStart: 0, turnEnd: 1, charStart: 11, charEnd: 11 })
    expect(empty?.text).toBe('')
    expect(empty?.contentHash).toBe(transcriptHash(''))
  })

  it('returns undefined/empty for unknown sessions and turns', () => {
    const store = storeIn()
    expect(store.hasSession('missing')).toBe(false)
    expect(store.readTurn('missing', 0)).toBeUndefined()
    expect(store.readTurns('missing', 0, 10)).toEqual([])
    expect(store.readRange('missing', { turnStart: 0, turnEnd: 0 })).toBeUndefined()
    store.appendTurn({ sessionId: 's1', turnIndex: 0, role: 'user', text: 'only' })
    expect(store.readRange('s1', { turnStart: 5, turnEnd: 6 })).toBeUndefined()
    expect(store.readTurn('s1', 5)).toBeUndefined()
  })

  it('keeps unicode offsets slice-exact', () => {
    const store = storeIn()
    const text = 'héllo 👋 世界'
    store.appendTurn({ sessionId: 's1', turnIndex: 0, role: 'user', text })
    store.appendTurn({ sessionId: 's1', turnIndex: 1, role: 'assistant', text: '🙂 ok' })
    const rows = store.readTurns('s1', 0, 1)
    expect(rows[0]?.char_end).toBe(text.length)
    expect(rows[1]?.char_start).toBe(text.length + 2)
    const canonical = `${text}\n\n🙂 ok`
    const range = store.readRange('s1', { turnStart: 0, turnEnd: 1 })
    expect(range?.text).toBe(canonical)
    expect(canonical.slice(rows[1]?.char_start, rows[1]?.char_end)).toBe('🙂 ok')
  })

  it('lists sessions in sorted order and releases its lock', () => {
    const store = storeIn()
    store.appendTurn({ sessionId: 's-b', turnIndex: 0, role: 'user', text: 'b' })
    store.appendTurn({ sessionId: 's-a', turnIndex: 0, role: 'user', text: 'a' })
    expect(store.sessions()).toEqual(['s-a', 's-b'])
    expect(existsSync(`${transcriptPathFor('s-a', store.dir)}.lock`)).toBe(false)
  })
})
