import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from '../src/cli/main.js'
import { TranscriptStore } from '../src/memory/transcript-store.js'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function seededStore(): { env: NodeJS.ProcessEnv; text: string } {
  const directory = mkdtempSync(join(tmpdir(), 'transcript-cli-'))
  directories.push(directory)
  const text = 'line one\nline two with unicode 👋'
  const store = new TranscriptStore({ dir: join(directory, 'transcripts') })
  store.appendTurn({ sessionId: 'session-cli', turnIndex: 0, role: 'user', text })
  store.appendTurn({ sessionId: 'session-cli', turnIndex: 1, role: 'assistant', text: 'answer' })
  return { env: { COGNEE_MEMORY_TRANSCRIPTS_DIR: join(directory, 'transcripts') }, text }
}

function capture(): { io: { out: (line: string) => void; err: (line: string) => void }; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err }
}

describe('memory transcript show', () => {
  it('prints a turn range with offsets and a preview', async () => {
    const { env, text } = seededStore()
    const sink = capture()
    const code = await runCli(['transcript', 'show', '--session', 'session-cli', '--turns', '0..0'], env, sink.io)
    expect(code).toBe(0)
    expect(sink.out[0]).toBe('session: session-cli  turns: 0..0  rows: 1')
    expect(sink.out[1]).toContain('turn 0 user')
    expect(sink.out[1]).toContain('chars 0..')
    expect(sink.out[1]).toContain('line one line two with unicode 👋')
    expect(text.length).toBeGreaterThan(0)
  })

  it('emits JSON rows when --json is set', async () => {
    const { env } = seededStore()
    const sink = capture()
    const code = await runCli(['transcript', 'show', '--session', 'session-cli', '--json'], env, sink.io)
    expect(code).toBe(0)
    const body = JSON.parse(sink.out[0] ?? '') as {
      sessionId: string
      turns: unknown
      rows: Array<{ turn_index: number; role: string; text: string }>
    }
    expect(body.sessionId).toBe('session-cli')
    expect(body.turns).toBeNull()
    expect(body.rows.map((row) => row.role)).toEqual(['user', 'assistant'])
  })

  it('fails honestly for an unknown session and a reversed range', async () => {
    const { env } = seededStore()
    const missing = capture()
    expect(await runCli(['transcript', 'show', '--session', 'nope'], env, missing.io)).toBe(1)
    expect(missing.err[0]).toContain('no transcript for session nope')
    const reversed = capture()
    expect(
      await runCli(['transcript', 'show', '--session', 'session-cli', '--turns', '2..1'], env, reversed.io),
    ).toBe(1)
    expect(reversed.err[0]).toContain('reversed')
  })
})
