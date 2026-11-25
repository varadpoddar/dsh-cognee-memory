import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from '../src/cli/main.js'

function envFor(dir: string): NodeJS.ProcessEnv {
  return {
    HOME: dir,
    DSH_HOME: join(dir, '.dsh'),
    COGNEE_MEMORY_API_BASE_URL: 'http://127.0.0.1:9/api/v1',
    COGNEE_QUEUE_BASE_BACKOFF_MS: '10',
  } as NodeJS.ProcessEnv
}

function capture() {
  const lines: string[] = []
  return {
    lines,
    io: {
      out: (line: string) => lines.push(line),
      err: (line: string) => lines.push(`err:${line}`),
    },
  }
}

describe('memory queue drain flags', () => {
  it('accepts --batch-size and reports the chosen batch on a dry run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cognee-cli-'))
    const sink = capture()
    const code = await runCli(['queue', 'drain', '--batch-size', '25'], envFor(dir), sink.io)
    expect(code).toBe(0)
    expect(sink.lines.join('\n')).toContain('batch 25')
  })

  it('defaults the batch to the configured ingestBatchSize (25)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cognee-cli-'))
    const sink = capture()
    const code = await runCli(['queue', 'drain'], envFor(dir), sink.io)
    expect(code).toBe(0)
    expect(sink.lines.join('\n')).toContain('batch 25')
  })

  it('honours COGNEE_QUEUE_INGEST_BATCH_SIZE when the flag is absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cognee-cli-'))
    const sink = capture()
    const env = { ...envFor(dir), COGNEE_QUEUE_INGEST_BATCH_SIZE: '5' }
    const code = await runCli(['queue', 'drain'], env, sink.io)
    expect(code).toBe(0)
    expect(sink.lines.join('\n')).toContain('batch 5')
  })
})
