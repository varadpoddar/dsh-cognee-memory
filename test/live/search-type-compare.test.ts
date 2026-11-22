import { describe, expect, it } from 'vitest'

/**
 * Milestone 6 evidence: which Cognee search type ranks our data best.
 *
 * READ-ONLY. This test creates, writes, and deletes nothing. It only calls
 * `GET /datasets`, `POST /search`, and `POST /recall` against the existing
 * project fixture datasets and prints the measured comparison.
 *
 *   COGNEE_API_KEY=... COGNEE_BASE_URL=http://10.20.10.15:8000/api/v1 \
 *     npx vitest run --config vitest.live.config.ts test/live/search-type-compare.test.ts
 */
const apiKey = process.env.COGNEE_API_KEY?.trim()
const baseUrl = (process.env.COGNEE_BASE_URL ?? 'http://10.20.10.15:8000/api/v1').replace(/\/+$/, '')
const origin = new URL(baseUrl).origin
const QUESTION = 'What is the release codename and the deployment target?'
const FIXTURE_TOKENS = ['amber-otter-7731', 'CT 103'] as const
const TOP_K = 8
const RUNS = 3
/** The M1 hashed dataset name and the current durable name for the same scope. */
const FIXTURE_DATASET_NAMES = [
  'dsh_cognee_project_project-4be96e7c2cdbb95a1ac9',
  'dsh-project-project-4be96e7c2cdbb95a1ac9',
  'dsh-project-e2e',
]

interface Dataset {
  readonly id: string
  readonly name: string
}

interface Measurement {
  readonly strategy: string
  readonly latencies: number[]
  readonly items: number
  readonly ranks: Readonly<Record<string, number | null>>
  readonly matched: boolean
  readonly error?: string
}

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown; ms: number }> {
  const started = Date.now()
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      'X-Api-Key': apiKey ?? '',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  let body: unknown = text
  try {
    body = text === '' ? undefined : JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body, ms: Date.now() - started }
}

function resultTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const texts: string[] = []
  for (const group of value) {
    if (group === null || typeof group !== 'object') continue
    const items = (group as { search_result?: unknown }).search_result
    if (!Array.isArray(items)) continue
    for (const item of items) {
      if (item === null || typeof item !== 'object') continue
      const candidate = item as { text?: unknown; content?: unknown; description?: unknown }
      const text =
        typeof candidate.text === 'string'
          ? candidate.text
          : typeof candidate.content === 'string'
            ? candidate.content
            : typeof candidate.description === 'string'
              ? candidate.description
              : ''
      if (text !== '') texts.push(text)
    }
  }
  return texts
}

function firstNonEmptyTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry === 'string') return [entry]
    if (entry !== null && typeof entry === 'object') {
      const candidate = entry as { text?: unknown; content?: unknown }
      if (typeof candidate.text === 'string') return [candidate.text]
      if (typeof candidate.content === 'string') return [candidate.content]
    }
    return []
  })
}

function rankOf(texts: readonly string[], token: string): number | null {
  const index = texts.findIndex((text) => text.toLowerCase().includes(token.toLowerCase()))
  return index < 0 ? null : index + 1
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
    : (sorted[middle] ?? 0)
}

function p95(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] ?? 0
}

describe.skipIf(apiKey === undefined || apiKey === '')('Cognee search-type comparison (live, read-only)', () => {
  it('measures CHUNKS vs GRAPH_COMPLETION vs recall on the existing fixtures', async () => {
    const listing = await api('/api/v1/datasets')
    expect(listing.status).toBe(200)
    const datasets = (Array.isArray(listing.body) ? listing.body : []) as Dataset[]
    const fixture = datasets.filter((dataset) => FIXTURE_DATASET_NAMES.includes(dataset.name))
    expect(fixture.length).toBeGreaterThan(0)
    const datasetIds = fixture.map((dataset) => dataset.id)

    const measureSearch = async (searchType: string): Promise<Measurement> => {
      const latencies: number[] = []
      let texts: string[] = []
      let error: string | undefined
      for (let run = 0; run < RUNS; run += 1) {
        try {
          const result = await api('/api/v1/search', {
            method: 'POST',
            body: JSON.stringify({ query: QUESTION, searchType, datasetIds, topK: TOP_K }),
          })
          latencies.push(result.ms)
          if (result.status !== 200) error = `HTTP ${result.status}`
          else texts = resultTexts(result.body)
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught)
        }
      }
      const ranks: Record<string, number | null> = {}
      for (const token of FIXTURE_TOKENS) ranks[token] = rankOf(texts, token)
      return {
        strategy: searchType,
        latencies,
        items: texts.length,
        ranks,
        matched: FIXTURE_TOKENS.some((token) => ranks[token] !== null),
        ...(error === undefined ? {} : { error }),
      }
    }

    const measureRecall = async (): Promise<Measurement> => {
      const latencies: number[] = []
      let texts: string[] = []
      let error: string | undefined
      for (let run = 0; run < RUNS; run += 1) {
        try {
          const result = await api('/api/v1/recall', {
            method: 'POST',
            body: JSON.stringify({
              query: QUESTION,
              datasetIds,
              topK: TOP_K,
              onlyContext: true,
            }),
          })
          latencies.push(result.ms)
          if (result.status !== 200) error = `HTTP ${result.status}`
          else texts = firstNonEmptyTexts(result.body)
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught)
        }
      }
      const ranks: Record<string, number | null> = {}
      for (const token of FIXTURE_TOKENS) ranks[token] = rankOf(texts, token)
      return {
        strategy: 'recall',
        latencies,
        items: texts.length,
        ranks,
        matched: FIXTURE_TOKENS.some((token) => ranks[token] !== null),
        ...(error === undefined ? {} : { error }),
      }
    }

    const measurements = [
      await measureSearch('CHUNKS'),
      await measureSearch('GRAPH_COMPLETION'),
      await measureRecall(),
    ]
    const report = measurements.map((measurement) => ({
      strategy: measurement.strategy,
      runs: measurement.latencies.length,
      medianMs: median(measurement.latencies),
      p95Ms: p95(measurement.latencies),
      items: measurement.items,
      amberOtterRank: measurement.ranks['amber-otter-7731'] ?? null,
      ct103Rank: measurement.ranks['CT 103'] ?? null,
      matched: measurement.matched,
      ...(measurement.error === undefined ? {} : { error: measurement.error }),
    }))

    const header = '| strategy | runs | median ms | p95 ms | items | amber rank | CT103 rank | fixture |'
    const rows = report.map(
      (row) =>
        `| ${row.strategy} | ${row.runs} | ${row.medianMs} | ${row.p95Ms} | ${row.items} | ${
          row.amberOtterRank ?? '-'
        } | ${row.ct103Rank ?? '-'} | ${row.matched ? 'yes' : 'no'}${
          row.error === undefined ? '' : ` (${row.error})`
        } |`,
    )
    console.log(`SEARCH-TYPE COMPARISON ${new Date().toISOString()}`)
    console.log(`query: ${QUESTION}`)
    console.log(`datasets: ${fixture.map((dataset) => dataset.name).join(', ')} (topK=${TOP_K})`)
    console.log([header, '| --- | --- | --- | --- | --- | --- | --- | --- |', ...rows].join('\n'))
    console.log(`SEARCH-TYPE COMPARISON JSON ${JSON.stringify(report)}`)

    expect(report.length).toBe(3)
    expect(report.some((row) => row.matched)).toBe(true)
  }, 300_000)
})
