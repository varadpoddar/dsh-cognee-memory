import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config/schema.js'
import { MemoryError } from '../src/errors.js'
import { segmentHash } from '../src/memory/segmenter.js'
import {
  buildSummaryPointerFromSegment,
  parseSummaryDocument,
  parseSummaryPointer,
  renderSummaryDocument,
  renderSummaryHeader,
  serializeSummaryPointer,
} from '../src/memory/pointer.js'
import { IngestQueue } from '../src/queue/store.js'
import {
  SUMMARY_DEFAULT_MAX_OUTPUT_TOKENS,
  SUMMARY_MERGE_PROMPT,
  SUMMARY_MODEL,
  SUMMARY_PROMPT,
  SUMMARY_PROMPT_VERSION,
  enqueueSummary,
  estimateTokens,
  resolveSummaryRuntime,
  summarizeSegment,
  summaryDedupeKey,
  type SegmentSummary,
} from '../src/memory/summarizer.js'
import type { SegmentTurn, TurnSegment } from '../src/memory/segmenter.js'

interface CapturedCall {
  readonly url: string
  readonly system: string
  readonly user: string
  readonly body: Record<string, unknown>
}

function stubFetch(
  reply: (call: { readonly system: string; readonly user: string }, index: number) => string,
): { readonly fetchImpl: typeof fetch; readonly calls: CapturedCall[] } {
  const calls: CapturedCall[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: { role: string; content: string }[]
    } & Record<string, unknown>
    const system = body.messages?.find((message) => message.role === 'system')?.content ?? ''
    const user = body.messages?.find((message) => message.role === 'user')?.content ?? ''
    calls.push({ url: String(url), system, user, body })
    const content = reply({ system, user }, calls.length - 1)
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content } }] }
      },
    } as unknown as Response
  }) as typeof fetch
  return { fetchImpl, calls }
}

function segmentOf(turns: readonly SegmentTurn[], overrides: Partial<TurnSegment> = {}): TurnSegment {
  const text = turns.map((turn) => turn.text).join('\n\n')
  return {
    segmentIndex: 0,
    turnStart: turns[0]?.turnIndex ?? 0,
    turnEnd: turns.at(-1)?.turnIndex ?? 0,
    turns,
    text,
    charStart: 0,
    charEnd: text.length,
    contentHash: segmentHash(text),
    ...overrides,
  }
}

const SHORT_SEGMENT = segmentOf([
  { turnIndex: 2, role: 'user', text: 'Deploy the gateway on 10.20.10.5:8080 using key file /etc/dsh/llm.env.' },
  { turnIndex: 2, role: 'assistant', text: 'Decision: keep 10.20.10.5:8080 because TLS terminates there.' },
])

const OPTIONS = {
  endpoint: 'http://127.0.0.1:8888/v1',
  apiKey: 'test-key',
  timeoutMs: 1_000,
} as const

describe('pinned summarizer contract', () => {
  it('pins the prompt, version and model in code', () => {
    expect(SUMMARY_PROMPT_VERSION).toBe('1')
    expect(SUMMARY_MODEL).toBe('unsloth/Qwen3.8-27B-GGUF')
    expect(SUMMARY_PROMPT).toContain('credential FILE PATHS only')
    expect(SUMMARY_PROMPT).toContain('Never repeat a secret')
    expect(SUMMARY_PROMPT).toContain('Do not invent facts')
    expect(SUMMARY_MERGE_PROMPT).toContain('partial summaries')
    expect(estimateTokens('abcdefgh')).toBe(2)
  })

  it('sends the pinned prompt with temperature 0 and a fixed seed', async () => {
    const { fetchImpl, calls } = stubFetch(() => 'Gateway runs on 10.20.10.5:8080; TLS decision kept.')
    await summarizeSegment({ sessionId: 's1', segment: SHORT_SEGMENT }, { ...OPTIONS, fetchImpl })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('http://127.0.0.1:8888/v1/chat/completions')
    expect(calls[0]?.system).toBe(SUMMARY_PROMPT)
    expect(calls[0]?.body.model).toBe(SUMMARY_MODEL)
    expect(calls[0]?.body.temperature).toBe(0)
    expect(calls[0]?.body.seed).toBe(0)
    expect(calls[0]?.body.max_tokens).toBe(SUMMARY_DEFAULT_MAX_OUTPUT_TOKENS)
    expect(calls[0]?.body.chat_template_kwargs).toEqual({ enable_thinking: false })
  })

  it('omits the reasoning switch when disableReasoning is false', async () => {
    const { fetchImpl, calls } = stubFetch(() => 'Plain prose with no reasoning switch.')
    await summarizeSegment(
      { sessionId: 's1', segment: SHORT_SEGMENT },
      { ...OPTIONS, disableReasoning: false, fetchImpl },
    )
    expect(calls[0]?.body.chat_template_kwargs).toBeUndefined()
  })

  it('is deterministic for identical input', async () => {
    const reply = () => 'Same prose for the same segment.'
    const first = await summarizeSegment(
      { sessionId: 's1', segment: SHORT_SEGMENT },
      { ...OPTIONS, fetchImpl: stubFetch(reply).fetchImpl },
    )
    const second = await summarizeSegment(
      { sessionId: 's1', segment: SHORT_SEGMENT },
      { ...OPTIONS, fetchImpl: stubFetch(reply).fetchImpl },
    )
    expect(first.pointer).toEqual(second.pointer)
    expect(first.document).toBe(second.document)
    expect(first.requests).toBe(1)
  })

  it('refuses to emit secrets and redacts before sending', async () => {
    const secret = `sk-${'a'.repeat(30)}`
    const inputSecret = `sk-${'b'.repeat(30)}`
    const segment = segmentOf([
      { turnIndex: 1, role: 'user', text: `Use api_key = ${inputSecret} from /etc/dsh/llm.env.` },
      { turnIndex: 1, role: 'assistant', text: 'Understood.' },
    ])
    const { fetchImpl, calls } = stubFetch(
      () => `The key was ${secret} (path /etc/dsh/llm.env).`,
    )
    const summary = await summarizeSegment({ sessionId: 's1', segment }, { ...OPTIONS, fetchImpl })
    expect(summary.summaryText).toContain('[REDACTED:api_key]')
    expect(summary.summaryText).toContain('/etc/dsh/llm.env')
    expect(summary.summaryText).not.toContain(secret)
    expect(summary.summaryText).not.toContain(inputSecret)
    expect(summary.redactions).toBeGreaterThanOrEqual(2)
    expect(calls[0]?.user).not.toContain(inputSecret)
    expect(calls[0]?.user).toContain('/etc/dsh/llm.env')
    expect(summary.document).not.toContain(secret)
  })

  it('rejects a non-private endpoint before any request', async () => {
    const { fetchImpl, calls } = stubFetch(() => 'never')
    await expect(
      summarizeSegment(
        { sessionId: 's1', segment: SHORT_SEGMENT },
        { ...OPTIONS, endpoint: 'https://api.example.com/v1', fetchImpl },
      ),
    ).rejects.toBeInstanceOf(MemoryError)
    expect(calls).toHaveLength(0)
  })
})

describe('summary document pointer header', () => {
  it('round-trips pointer and prose with a fixed key order', () => {
    const pointer = buildSummaryPointerFromSegment(
      'session-1',
      SHORT_SEGMENT,
      SUMMARY_MODEL,
      SUMMARY_PROMPT_VERSION,
    )
    const header = renderSummaryHeader(pointer)
    expect(header.startsWith('[[dsh-memory-pointer {"session_id":"session-1"')).toBe(true)
    expect(header.endsWith(']]')).toBe(true)
    const json = header.slice('[[dsh-memory-pointer '.length, -2)
    expect(Object.keys(JSON.parse(json) as object)).toEqual([
      'session_id',
      'turn_start',
      'turn_end',
      'segment_index',
      'content_hash',
      'char_start',
      'char_end',
      'model',
      'prompt_version',
    ])
    const document = renderSummaryDocument(pointer, 'prose body')
    const parsed = parseSummaryDocument(document)
    expect(parsed?.pointer).toEqual(pointer)
    expect(parsed?.summaryText).toBe('prose body')
    expect(parseSummaryPointer(serializeSummaryPointer(pointer))).toEqual(pointer)
  })

  it('rejects malformed headers and missing identity fields', () => {
    const pointer = buildSummaryPointerFromSegment(
      'session-1',
      SHORT_SEGMENT,
      SUMMARY_MODEL,
      SUMMARY_PROMPT_VERSION,
    )
    expect(parseSummaryDocument('no header here')).toBeUndefined()
    expect(parseSummaryDocument(`[[dsh-memory-pointer {}]] prose`)).toBeUndefined()
    const { model: _model, ...withoutModel } = pointer
    expect(parseSummaryPointer(JSON.stringify(withoutModel))).toBeUndefined()
    const { prompt_version: _version, ...withoutVersion } = pointer
    expect(parseSummaryPointer(JSON.stringify(withoutVersion))).toBeUndefined()
  })

  it('scopes the dedupe identity to content hash, prompt version and model', () => {
    const pointer = buildSummaryPointerFromSegment(
      'session-1',
      SHORT_SEGMENT,
      SUMMARY_MODEL,
      SUMMARY_PROMPT_VERSION,
    )
    expect(summaryDedupeKey(pointer)).toBe(
      `${pointer.content_hash}:v1:${SUMMARY_MODEL}`,
    )
    expect(summaryDedupeKey({ ...pointer, prompt_version: '2' })).not.toBe(summaryDedupeKey(pointer))
  })
})

describe('long-segment map-reduce', () => {
  it('maps turn-groups then merges without exceeding the input budget', async () => {
    const segment = segmentOf([
      { turnIndex: 1, role: 'user', text: `alpha ${'x'.repeat(6_000)}` },
      { turnIndex: 1, role: 'assistant', text: `beta ${'y'.repeat(6_000)}` },
    ])
    const { fetchImpl, calls } = stubFetch(({ system }, index) =>
      system === SUMMARY_MERGE_PROMPT
        ? `merged summary ${index}`
        : `map ${index} 10.0.0.5:8080 decision kept`,
    )
    const summary = await summarizeSegment(
      { sessionId: 's-long', segment },
      { ...OPTIONS, maxInputChars: 1_500, maxOutputTokens: 200, fetchImpl },
    )
    const mapCalls = calls.filter((call) => call.system === SUMMARY_PROMPT)
    const mergeCalls = calls.filter((call) => call.system === SUMMARY_MERGE_PROMPT)
    expect(mapCalls.length).toBeGreaterThan(2)
    expect(mergeCalls.length).toBeGreaterThanOrEqual(1)
    expect(summary.requests).toBe(calls.length)
    for (const call of calls) {
      expect(call.user.length).toBeLessThanOrEqual(1_500 + 256)
    }
    expect(summary.summaryText).toContain('merged summary')
    expect(summary.inputChars).toBeGreaterThan(6_000)
    expect(parseSummaryDocument(summary.document)?.pointer).toEqual(summary.pointer)
  })

  it('clips the final prose at the hard output cap', async () => {
    const { fetchImpl } = stubFetch(() => `word ${'z'.repeat(5_000)}`)
    const summary = await summarizeSegment(
      { sessionId: 's1', segment: SHORT_SEGMENT },
      { ...OPTIONS, maxOutputTokens: 50, fetchImpl },
    )
    expect(summary.truncated).toBe(true)
    expect(summary.summaryText.length).toBeLessThanOrEqual(200)
    expect(summary.summaryText.endsWith('…')).toBe(true)
  })
})

describe('summary config and queue kind', () => {
  it('defaults are off and the varad profile is enabled only with env present', () => {
    const defaults = parseConfig({})
    expect(defaults.ingestion.summaries).toMatchObject({
      enabled: false,
      model: SUMMARY_MODEL,
      baseUrlEnv: 'COGNEE_SUMMARY_BASE_URL',
      apiKeyEnv: 'UNSLOTH_LARGE_API_KEY',
      maxOutputTokens: SUMMARY_DEFAULT_MAX_OUTPUT_TOKENS,
      concurrency: 2,
    })
    expect(defaults.ingestion.summaries.maxCharsPerSegment).toBeUndefined()
    const configured = parseConfig({ ingestion: { summaries: { enabled: true } } })
    const privateEnv = {
      COGNEE_SUMMARY_BASE_URL: 'http://10.20.10.40:8888/v1',
      UNSLOTH_LARGE_API_KEY: 'k',
    } as NodeJS.ProcessEnv
    expect(resolveSummaryRuntime(configured, privateEnv)).toMatchObject({
      enabled: true,
      reason: 'enabled',
      endpoint: 'http://10.20.10.40:8888/v1',
    })
    expect(resolveSummaryRuntime(configured, { ...privateEnv, UNSLOTH_LARGE_API_KEY: '' }).reason).toBe(
      'no-api-key',
    )
    expect(
      resolveSummaryRuntime(configured, {
        ...privateEnv,
        COGNEE_SUMMARY_BASE_URL: 'https://api.example.com/v1',
      }).reason,
    ).toBe('insecure-endpoint')
    expect(resolveSummaryRuntime(defaults, privateEnv).reason).toBe('disabled')
  })

  it('persists kind: "summary" on a queue task and keeps legacy rows as turn tasks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-summary-queue-'))
    const filePath = join(dir, 'queue.jsonl')
    const queue = IngestQueue.open({ filePath, syncWrites: false })
    const summary: SegmentSummary = {
      pointer: buildSummaryPointerFromSegment(
        's1',
        SHORT_SEGMENT,
        SUMMARY_MODEL,
        SUMMARY_PROMPT_VERSION,
      ),
      summaryText: 'prose',
      document: renderSummaryDocument(
        buildSummaryPointerFromSegment('s1', SHORT_SEGMENT, SUMMARY_MODEL, SUMMARY_PROMPT_VERSION),
        'prose',
      ),
      model: SUMMARY_MODEL,
      promptVersion: SUMMARY_PROMPT_VERSION,
      requests: 1,
      inputChars: 10,
      outputChars: 5,
      truncated: false,
      redactions: 0,
    }
    const scopeRef = { scope: 'project' as const, id: 'demo' }
    const first = enqueueSummary(queue, { summary, scope: 'dsh-project-demo', scopeRef })
    expect(first.added).toBe(1)
    const again = enqueueSummary(queue, { summary, scope: 'dsh-project-demo', scopeRef })
    expect(again.added).toBe(0)
    expect(again.duplicates).toBe(1)
    queue.enqueue([{ text: 'legacy turn task', scope: 'dsh-project-demo', scopeRef }])

    const reopened = IngestQueue.open({ filePath, syncWrites: false })
    const items = reopened.list()
    expect(items.find((item) => item.text === summary.document)?.kind).toBe('summary')
    expect(items.find((item) => item.text === 'legacy turn task')?.kind).toBeUndefined()
  })
})
