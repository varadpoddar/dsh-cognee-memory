import { describe, expect, it } from 'vitest'
import { segmentHash } from '../../src/memory/segmenter.js'
import { parseSummaryDocument, pointerMatches } from '../../src/memory/pointer.js'
import {
  SUMMARY_MODEL,
  SUMMARY_PROMPT_VERSION,
  summarizeSegment,
} from '../../src/memory/summarizer.js'

/**
 * Live check of the pinned summarizer against the local Qwen endpoint.
 *
 * Skipped unless `UNSLOTH_LARGE_API_KEY` is set (CT 103 reads it from
 * /etc/dsh/llm.env). It makes one real map call — no mocks — and asserts the
 * contract: private endpoint, non-empty prose, pointer header round-trip, and
 * no secret material in the output. Timing is printed for the cost model in
 * docs/SUMMARY_PIPELINE.md.
 */
const apiKey = process.env.UNSLOTH_LARGE_API_KEY?.trim() ?? ''
const endpoint = process.env.COGNEE_SUMMARY_BASE_URL?.trim() || 'http://10.20.10.40:8888/v1'

const userText =
  'Deploy the memory gateway on 10.20.10.5:8080. The Studio key lives in /etc/dsh/llm.env.'
const assistantText =
  'Decision: keep 10.20.10.5:8080 because TLS terminates at the gateway.\n' +
  'We tried port 9090 first; the health check failed, so we reverted.\n' +
  'Open question: who rotates the key file next?'
const segmentText = [userText, assistantText].join('\n\n')

const segment = {
  segmentIndex: 0,
  turnStart: 3,
  turnEnd: 4,
  turns: [
    { turnIndex: 3, role: 'user' as const, text: userText },
    { turnIndex: 4, role: 'assistant' as const, text: assistantText },
  ],
  text: segmentText,
  charStart: 0,
  charEnd: segmentText.length,
  contentHash: segmentHash(segmentText),
}

describe.skipIf(apiKey === '')('live summarizer (local Qwen)', () => {
  it('summarizes a small segment and preserves the pointer contract', async () => {
    const started = Date.now()
    const summary = await summarizeSegment(
      { sessionId: 'live-summary-probe', segment },
      {
        endpoint,
        apiKey,
        model: SUMMARY_MODEL,
        maxOutputTokens: 300,
        timeoutMs: 120_000,
      },
    )
    const elapsedMs = Date.now() - started
    // eslint-disable-next-line no-console
    console.log(
      `live summary: ${summary.summaryText.length} chars, ${summary.requests} request(s), ${elapsedMs} ms, model=${summary.model}, prompt=v${summary.promptVersion}`,
    )
    expect(summary.summaryText.length).toBeGreaterThan(20)
    expect(summary.summaryText).toMatch(/10\.20\.10\.5|8080/)
    expect(summary.summaryText).toContain('/etc/dsh/llm.env')
    expect(summary.summaryText.toLowerCase()).not.toContain('sk-unsloth')
    expect(summary.promptVersion).toBe(SUMMARY_PROMPT_VERSION)
    const parsed = parseSummaryDocument(summary.document)
    expect(parsed?.pointer).toEqual(summary.pointer)
    expect(parsed === undefined ? false : pointerMatches(parsed.pointer, segmentText)).toBe(true)
    expect(summary.document.startsWith('[[dsh-memory-pointer {')).toBe(true)
  }, 180_000)
})
