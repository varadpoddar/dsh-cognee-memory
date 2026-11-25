import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config/schema.js'
import { runBackfill, type BackfillOptions } from '../src/cli/backfill-transcripts.js'
import { runCli } from '../src/cli/main.js'
import { parseSummaryDocument, pointerMatches } from '../src/memory/pointer.js'
import { summarizeSegment } from '../src/memory/summarizer.js'
import { TranscriptStore } from '../src/memory/transcript-store.js'
import { IngestQueue } from '../src/queue/store.js'

function line(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

function writeSession(
  sessionsDir: string,
  project: string,
  file: string,
  events: readonly Record<string, unknown>[],
): string {
  const dir = join(sessionsDir, project)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, file)
  writeFileSync(path, `${events.map(line).join('\n')}\n`)
  return path
}

function turnEvents(
  sessionId: string,
  turns: ReadonlyArray<{ user: string; assistant: string }>,
): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [{ type: 'session', id: sessionId, createdAt: 1_700_000_000_000 }]
  let seq = 0
  turns.forEach((turn, index) => {
    const n = index + 1
    events.push({ type: 'turn/start', seq: ++seq, data: { turn: n } })
    events.push({
      type: 'user/message',
      seq: ++seq,
      time: 1_700_000_000_000 + n * 1_000,
      data: { content: [{ type: 'text', text: turn.user }], source: { kind: 'user' } },
    })
    events.push({
      type: 'assistant/message',
      seq: ++seq,
      time: 1_700_000_000_500 + n * 1_000,
      data: { turn: n, message: { role: 'assistant', content: [{ type: 'text', text: turn.assistant }] } },
    })
    events.push({ type: 'turn/end', seq: ++seq, data: { turn: n } })
  })
  return events
}

function stubFetch(reply: (index: number) => string): typeof fetch {
  let index = 0
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: { role: string; content: string }[]
    }
    void body
    const content = reply(index)
    index += 1
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content } }] }
      },
    } as unknown as Response
  }) as typeof fetch
}

function fixture(): {
  readonly root: string
  readonly sessionsDir: string
  readonly storeDir: string
  readonly queuePath: string
} {
  const root = mkdtempSync(join(tmpdir(), 'dsh-backfill-'))
  const sessionsDir = join(root, 'sessions')
  writeSession(
    sessionsDir,
    'project-a',
    'session.v4.jsonl',
    turnEvents('session-a', [
      {
        user: 'Deploy the gateway on 10.0.0.5:8080 with the key file /etc/dsh/llm.env.',
        assistant: 'Decision: keep 10.0.0.5:8080 because TLS terminates there.',
      },
      {
        user: 'Next: rotate the key in /etc/dsh/llm.env.',
        assistant: 'Open question: who owns the rotation?',
      },
    ]),
  )
  writeSession(
    sessionsDir,
    'project-b',
    'session.v3.jsonl',
    turnEvents('session-b', [
      {
        user: 'Short note about redis on 10.0.0.9:6379.',
        assistant: 'Noted; no decision yet.',
      },
    ]),
  )
  return {
    root,
    sessionsDir,
    storeDir: join(root, 'transcripts'),
    queuePath: join(root, 'ingest-queue.jsonl'),
  }
}

function options(
  fixed: ReturnType<typeof fixture>,
  extra: Partial<BackfillOptions> = {},
): BackfillOptions {
  return {
    sessionsDir: fixed.sessionsDir,
    apply: false,
    config: parseConfig({}),
    env: {},
    scope: { scope: 'project', id: 'demo' },
    transcripts: new TranscriptStore({ dir: fixed.storeDir, syncWrites: false }),
    queue: IngestQueue.open({ filePath: fixed.queuePath, syncWrites: false }),
    concurrency: 1,
    ...extra,
  }
}

describe('backfill-transcripts', () => {
  it('dry run reports the plan and writes nothing', async () => {
    const fixed = fixture()
    const store = new TranscriptStore({ dir: fixed.storeDir, syncWrites: false })
    const queue = IngestQueue.open({ filePath: fixed.queuePath, syncWrites: false })
    const report = await runBackfill(
      options(fixed, { transcripts: store, queue, summarizer: undefined }),
    )
    expect(report.dryRun).toBe(true)
    expect(report.sessions).toBe(2)
    expect(report.messages).toBe(6)
    expect(report.turns).toBe(6)
    expect(report.segments).toBe(6)
    expect(report.newRows).toBe(6)
    expect(report.duplicateRows).toBe(0)
    expect(report.summaries).toBe(0)
    expect(report.enqueued).toBe(0)
    expect(report.estimatedRequests).toBe(6)
    expect(report.estimatedMs).toBe(6 * 15_000)
    expect(report.estimatedInputTokens).toBeGreaterThan(0)
    // Nothing written, nothing enqueued.
    expect(existsSync(fixed.storeDir) ? readdirSync(fixed.storeDir) : []).toEqual([])
    expect(queue.status().total).toBe(0)
  })

  it('apply writes rows, segments, and summary tasks resolvable by pointer', async () => {
    const fixed = fixture()
    const store = new TranscriptStore({ dir: fixed.storeDir, syncWrites: false })
    const queue = IngestQueue.open({ filePath: fixed.queuePath, syncWrites: false })
    const summarizer = (input: { sessionId: string; segment: Parameters<typeof summarizeSegment>[0]['segment'] }) =>
      summarizeSegment(input, {
        endpoint: 'http://127.0.0.1:8888/v1',
        apiKey: 'k',
        maxOutputTokens: 200,
        timeoutMs: 1_000,
        fetchImpl: stubFetch((index) => `summary ${index} for ${input.sessionId}`),
      })
    const report = await runBackfill(
      options(fixed, { apply: true, transcripts: store, queue, summarizer }),
    )
    expect(report.dryRun).toBe(false)
    expect(report.sessions).toBe(2)
    expect(report.newRows).toBe(6)
    expect(report.segments).toBe(6)
    expect(report.summaries).toBe(6)
    expect(report.enqueued).toBe(6)
    expect(report.failures).toBe(0)

    const stored = store.readTurns('session-a', 0, Number.MAX_SAFE_INTEGER)
    expect(stored.map((row) => `${row.turn_index}:${row.role}`)).toEqual([
      '1:user',
      '1:assistant',
      '2:user',
      '2:assistant',
    ])
    expect(stored[0]?.text).toContain('/etc/dsh/llm.env')

    const items = queue.list()
    expect(items).toHaveLength(6)
    expect(items.every((item) => item.kind === 'summary')).toBe(true)
    for (const item of items) {
      const parsed = parseSummaryDocument(item.text)
      expect(parsed).toBeDefined()
      if (parsed === undefined) continue
      const resolved = store.readRange(parsed.pointer.session_id, {
        turnStart: parsed.pointer.turn_start,
        turnEnd: parsed.pointer.turn_end,
        charStart: parsed.pointer.char_start,
        charEnd: parsed.pointer.char_end,
      })
      expect(resolved).toBeDefined()
      expect(pointerMatches(parsed.pointer, resolved?.text ?? '')).toBe(true)
      expect(parsed.summaryText).toContain('summary')
      expect(item.scopeRef).toEqual({ scope: 'project', id: 'demo' })
    }
  })

  it('re-running apply is idempotent: zero new rows, zero new tasks', async () => {
    const fixed = fixture()
    const store = new TranscriptStore({ dir: fixed.storeDir, syncWrites: false })
    const queue = IngestQueue.open({ filePath: fixed.queuePath, syncWrites: false })
    const summarizer = (input: { sessionId: string; segment: Parameters<typeof summarizeSegment>[0]['segment'] }) =>
      summarizeSegment(input, {
        endpoint: 'http://127.0.0.1:8888/v1',
        apiKey: 'k',
        maxOutputTokens: 200,
        timeoutMs: 1_000,
        fetchImpl: stubFetch((index) => `summary ${index}`),
      })
    const run = (): Promise<Awaited<ReturnType<typeof runBackfill>>> =>
      runBackfill(options(fixed, { apply: true, transcripts: store, queue, summarizer }))
    const first = await run()
    expect(first.enqueued).toBe(6)
    const second = await run()
    expect(second.newRows).toBe(0)
    expect(second.duplicateRows).toBe(6)
    expect(second.summaries).toBe(6)
    expect(second.enqueued).toBe(0)
    expect(second.duplicateSummaries).toBe(6)
    expect(queue.status().total).toBe(6)
  })

  it('CLI parses --from-sessions/--dry-run and refuses apply without summaries', async () => {
    const fixed = fixture()
    const cliEnv = {
      HOME: fixed.root,
      DSH_HOME: join(fixed.root, 'dsh-home'),
      DSH_MEMORY_PROJECT: 'demo',
      COGNEE_MEMORY_TRANSCRIPTS_DIR: fixed.storeDir,
      COGNEE_MEMORY_QUEUE_FILE: fixed.queuePath,
    } as NodeJS.ProcessEnv
    const lines: string[] = []
    const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) }
    const code = await runCli(
      ['backfill-transcripts', '--from-sessions', fixed.sessionsDir, '--dry-run'],
      cliEnv,
      io,
    )
    expect(code).toBe(0)
    const output = lines.join('\n')
    expect(output).toContain('backfill (dry run): sessions 2')
    expect(output).toContain('segments 6')
    expect(output).toContain('summaries: would enqueue 6')
    expect(output).toContain('dry run — pass --apply')
    expect(existsSync(fixed.storeDir)).toBe(false)

    const denied: string[] = []
    const deniedCode = await runCli(
      ['backfill-transcripts', '--from-sessions', fixed.sessionsDir, '--apply'],
      cliEnv,
      { out: (line: string) => denied.push(line), err: (line: string) => denied.push(line) },
    )
    expect(deniedCode).toBe(1)
    expect(denied.join('\n')).toContain('CONFIG')
    expect(denied.join('\n')).toContain('disabled')
  })

  it('honours --roles user, --limit, and refuses apply without summaries', async () => {
    const fixed = fixture()
    const store = new TranscriptStore({ dir: fixed.storeDir, syncWrites: false })
    const queue = IngestQueue.open({ filePath: fixed.queuePath, syncWrites: false })
    const userOnly = await runBackfill(
      options(fixed, { roles: 'user', transcripts: store, queue, limitSessions: 1 }),
    )
    expect(userOnly.sessions).toBe(1)
    expect(userOnly.turns).toBe(2)
    expect(userOnly.segments).toBe(1)
    await expect(
      runBackfill(options(fixed, { apply: true, transcripts: store, queue })),
    ).rejects.toMatchObject({ code: 'CONFIG' })
  })
})
