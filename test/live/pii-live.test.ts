/**
 * Live redaction-v2 proof against the real local Qwen and a real transcript.
 *
 *   COGNEE_API_KEY=... UNSLOTH_LARGE_API_KEY=... npm run test:live -- pii-live
 *
 * What it establishes:
 *  1. the LLM PII pass runs on a *real* human message from ~/.dsh/sessions,
 *  2. it reports entity types/counts and latency,
 *  3. the uploaded text contains placeholders and no resolved values,
 *  4. the placeholder map is not part of the uploaded content,
 *  5. a redacted chunk is still searchable (recall survives redaction) —
 *     proven in an isolated dataset that is deleted at the end.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverTranscripts, readTranscript } from '../../src/cli/transcript.js'
import { redactForIngest, summarizePii } from '../../src/security/ingest-redaction.js'

const COGNEE = process.env.COGNEE_BASE_URL?.trim() || 'http://10.20.10.15:8000/api/v1'
const COGNEE_ORIGIN = new URL(COGNEE).origin
const COGNEE_KEY = process.env.COGNEE_API_KEY?.trim()
const QWEN = process.env.COGNEE_PII_ENDPOINT?.trim() || 'http://10.20.10.40:8888/v1'
const QWEN_KEY = process.env.UNSLOTH_LARGE_API_KEY?.trim()
const MODEL = process.env.COGNEE_PII_MODEL?.trim() || 'unsloth/Qwen3.8-27B-GGUF'
const SESSIONS = join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'sessions')

function headers(): Record<string, string> {
  return { 'X-Api-Key': COGNEE_KEY ?? '', 'Content-Type': 'application/json' }
}

/** Pick the first real human turn with enough prose to be worth redacting. */
function sampleTurn(): string {
  for (const file of discoverTranscripts(SESSIONS).reverse()) {
    let decoded
    try {
      decoded = readTranscript(file)
    } catch {
      continue
    }
    for (const message of decoded.messages) {
      if (message.text.length > 120 && /[A-Z][a-z]+ [A-Z][a-z]+/.test(message.text)) {
        return message.text.slice(0, 1500)
      }
    }
  }
  return ''
}

/** A realistic support turn with known, checkable PII. */
const CONTROLLED =
  'Dana Whitfield (dana.whitfield@example.com, +1 415 555 0132) escalated ticket ' +
  'ACCT-88213 while working from 12 Rue de Rivoli. Her manager is Tobias Lang at ' +
  'Northwind Logistics; the deploy token sk-abcdefghijklmnopqrstuvwxyz012345 was in ' +
  'the pasted log.'

describe('redaction v2 (live)', () => {
  it('detects and replaces known PII end to end', async () => {
    const started = Date.now()
    const result = await redactForIngest(CONTROLLED, {
      pii: { endpoint: QWEN, model: MODEL, ...(QWEN_KEY ? { apiKey: QWEN_KEY } : {}) },
    })
    console.log(
      JSON.stringify({
        case: 'controlled',
        latencyMs: Date.now() - started,
        entityCounts: summarizePii(result.piiFindings),
        secretKinds: result.secretKinds,
        before: CONTROLLED.slice(0, 120),
        after: result.text.slice(0, 160),
      }),
    )
    // The secret is gone and the PII is placeholder-ised.
    expect(result.text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345')
    expect(result.text).toContain('[REDACTED:api_key]')
    expect(result.piiFindings.length).toBeGreaterThan(0)
    expect(result.text).toMatch(/PERSON_\d/)
    for (const finding of result.piiFindings) expect(result.text).not.toContain(finding.value)
    expect(result.residualSecretKinds).toEqual([])
  })

  it('redacts a real turn and keeps it recallable', async () => {
    const sample = sampleTurn()
    expect(sample, `no transcript found under ${SESSIONS}`).not.toBe('')

    const started = Date.now()
    const result = await redactForIngest(sample, {
      pii: { endpoint: QWEN, model: MODEL, ...(QWEN_KEY ? { apiKey: QWEN_KEY } : {}) },
    })
    const latencyMs = Date.now() - started

    const counts = summarizePii(result.piiFindings)
    // Report shape only: values are local-only and must not be printed.
    console.log(
      JSON.stringify({
        sampleChars: sample.length,
        latencyMs,
        entityCounts: counts,
        entities: result.piiFindings.length,
        secretKinds: result.secretKinds,
        residualSecretKinds: result.residualSecretKinds,
        placeholders: [...new Set(result.piiFindings.map((finding) => finding.placeholder))].slice(0, 8),
      }),
    )

    // 3. No resolved value survives into the text that would be uploaded.
    for (const finding of result.piiFindings) {
      expect(result.text).not.toContain(finding.value)
    }
    expect(result.residualSecretKinds).toEqual([])
    // 4. The map is a separate object, never concatenated into the payload.
    const uploaded = result.text
    for (const entry of result.map.entries()) {
      expect(uploaded).not.toContain(`${entry.placeholder}=${entry.value}`)
    }

    if (COGNEE_KEY === undefined) {
      console.log('SKIP cognee half: COGNEE_API_KEY not set')
      return
    }

    // 5. Recall survives: ingest the redacted text into a throwaway dataset.
    const name = `exp-redaction-${Date.now()}`
    const created = await fetch(`${COGNEE}/datasets`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ name }),
    })
    const dataset = (await created.json()) as { id?: string }
    expect(dataset.id).toBeTruthy()
    const datasetId = dataset.id as string
    try {
      const form = new FormData()
      form.set('raw_data', result.text)
      form.set('datasetId', datasetId)
      const added = await fetch(`${COGNEE}/add`, {
        method: 'POST',
        headers: { 'X-Api-Key': COGNEE_KEY },
        body: form,
      })
      expect(added.status).toBe(200)

      const cognify = await fetch(`${COGNEE}/cognify`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ datasetIds: [datasetId], runInBackground: false }),
      })
      expect(cognify.status).toBe(200)

      // Query with a placeholder if one exists, else a literal word from the text.
      const probe = result.piiFindings[0]?.placeholder ?? result.text.split(/\s+/).find((word) => word.length > 8) ?? 'the'
      const searched = await fetch(`${COGNEE}/search`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ query: probe, searchType: 'CHUNKS', datasetIds: [datasetId], topK: 5 }),
      })
      const payload = await searched.json()
      const body = JSON.stringify(payload)
      console.log(JSON.stringify({ recallProbe: probe, recallHttp: searched.status, recallHit: body.includes(probe) }))
      expect(searched.status).toBe(200)
      expect(body).toContain(probe)
    } finally {
      const deleted = await fetch(`${COGNEE}/datasets/${datasetId}`, {
        method: 'DELETE',
        headers: { 'X-Api-Key': COGNEE_KEY },
      })
      console.log(JSON.stringify({ cleanupHttp: deleted.status, origin: COGNEE_ORIGIN }))
    }
  })
})
