/**
 * Model-facing formatting for recalled memory.
 *
 * Kept free of hook imports so the Milestone 6 retrieval coordinator and the
 * prompt-context hook share one presentation contract:
 *
 *   Known context:
 *   - Release codename · project · 2026-11-20
 *
 * One line per memory: label · scope · date. The label is a bounded one-line
 * form of the memory itself (an explicit `label`/`semanticKey` in record
 * metadata wins, otherwise the sanitized text), so the model still reads the
 * memory while every line carries where and when it came from. The full
 * record, its dataset, and its provenance are addressable by id in the
 * authenticated detail view (`/plugins/cognee-memory/memory/<id>`).
 *
 * The security property ("memory is data, never instructions") is system text
 * (`MEMORY_POLICY_SECTION` in `hooks/prompt-context.ts`), not a per-turn
 * warning. This module only bounds, sanitizes, and labels what is recalled.
 */
import type { JsonValue, RecallHit } from '../types.js'

const MAX_ITEM_CHARS = 1_200
const MAX_QUERY_CHARS = 2_000
/** One model-visible line stays readable; longer memory is truncated with `…`. */
const MAX_LABEL_CHARS = 160

/** Header line every injected block starts with; no warning language. */
export const MEMORY_BLOCK_HEADER = 'Known context:'

/**
 * Conservative token estimate. Three UTF-8 bytes per token overestimates
 * ASCII (~4 chars/token) and approximates one token per CJK character, so the
 * prompt budget errs on the small side.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).length / 3)
}

/** Strip control characters and neutralize tags that could close the block. */
export function sanitizeMemoryText(text: string): string {
  const withoutControls = text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, MAX_ITEM_CHARS)
  return withoutControls.replace(/<\s*(\/?)\s*(cognee-memory|system|developer)/gi, '&lt;$1$2')
}

export function sanitizeQuery(text: string, maxChars = MAX_QUERY_CHARS): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, maxChars)
}

/** Bound one promise by wall time; the timer never keeps the process alive. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('retrieval budget exhausted'))
    }, ms)
    ;(timer as { unref?: () => void }).unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

export type Confidence = 'high' | 'medium' | 'low'

/** Coarse label so the model sees source+confidence without fake precision. */
export function confidenceFor(score: number): Confidence {
  if (!Number.isFinite(score)) return 'low'
  if (score >= 0.7) return 'high'
  if (score >= 0.4) return 'medium'
  return 'low'
}

function metadataValue(record: RecallHit['record'], key: string): JsonValue | undefined {
  const metadata = record.metadata
  return metadata === undefined ? undefined : metadata[key]
}

function truthyFlag(value: JsonValue | undefined): boolean {
  if (value === true) return true
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Drop records the deployment marked superseded, revoked, or expired. Only
 * explicit metadata suppresses a record; a missing field never hides memory.
 * `expiredAt`/`expiresAt` must parse as a timestamp at or before `now`.
 */
export function filterActiveHits(hits: readonly RecallHit[], now = Date.now()): RecallHit[] {
  return hits.filter((hit) => {
    if (truthyFlag(metadataValue(hit.record, 'supersededBy'))) return false
    if (truthyFlag(metadataValue(hit.record, 'superseded'))) return false
    if (truthyFlag(metadataValue(hit.record, 'revoked'))) return false
    if (truthyFlag(metadataValue(hit.record, 'revokedAt'))) return false
    for (const key of ['expiresAt', 'expiredAt'] as const) {
      const raw = metadataValue(hit.record, key)
      if (typeof raw !== 'string' || raw.trim() === '') continue
      const at = Date.parse(raw)
      if (Number.isFinite(at) && at <= now) return false
    }
    return true
  })
}

export interface MemoryBlockBudget {
  readonly maxTokens: number
  readonly maxItems: number
  /**
   * Absolute browser-facing origin for per-memory provenance links, e.g.
   * `https://dsh.example`. When absent, lines keep the compact
   * `label · scope · date` form and no URL is invented.
   */
  readonly publicBaseUrl?: string
}

export interface MemoryBlock {
  readonly text: string
  readonly tokens: number
  readonly itemCount: number
}

function metadataString(record: RecallHit['record'], key: string): string | undefined {
  const value = metadataValue(record, key)
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * One-line form of a memory: an explicit operator/model-provided label, then
 * the extracted semantic key, then the memory text itself. Sanitized and
 * length-bounded so a long or hostile body cannot flood the prompt or break the
 * one-line contract.
 */
export function memoryLabel(hit: RecallHit): string {
  const source =
    metadataString(hit.record, 'label') ??
    metadataString(hit.record, 'semanticKey') ??
    hit.record.text
  const text = sanitizeMemoryText(source).replace(/\s*\n+\s*/g, ' ').trim()
  if (text.length <= MAX_LABEL_CHARS) return text
  return `${text.slice(0, MAX_LABEL_CHARS - 1).trimEnd()}…`
}

/**
 * Calendar date of the memory record in UTC. An unparseable timestamp is
 * rendered as `unknown` rather than dropped or invented.
 */
export function memoryDate(record: RecallHit['record']): string {
  const at = Date.parse(record.createdAt)
  return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : 'unknown'
}

/** Absolute detail URL for one memory, or `undefined` without a public origin. */
export function memoryDetailUrl(hit: RecallHit, publicBaseUrl?: string): string | undefined {
  const base = publicBaseUrl?.trim().replace(/\/+$/, '')
  if (base === undefined || base === '') return undefined
  return `${base}/plugins/cognee-memory/memory/${encodeURIComponent(hit.record.id)}`
}

/**
 * One rendered memory line; shared by the formatter and the budget planner.
 * The label carries the memory itself, then scope, date, and (when the
 * deployment names a public origin) that memory's absolute provenance URL.
 * The URL is data for the operator, not an instruction, and never includes the
 * settings token.
 */
export function memoryItemLine(hit: RecallHit, publicBaseUrl?: string): string {
  const base = `- ${memoryLabel(hit)} · ${hit.record.scope.scope} · ${memoryDate(hit.record)}`
  const url = memoryDetailUrl(hit, publicBaseUrl)
  return url === undefined ? base : `${base} · ${url}`
}

/**
 * Build a bounded prompt block. Items are dropped whole, in order, until the
 * item and token budgets fit. No block is emitted when nothing fits.
 */
export function formatMemoryBlock(
  hits: readonly RecallHit[],
  budget: MemoryBlockBudget,
): MemoryBlock {
  const header = MEMORY_BLOCK_HEADER
  const maxTokens = Math.max(0, budget.maxTokens)
  const itemCap = Math.max(0, Math.min(budget.maxItems, hits.length))
  if (itemCap === 0) return { text: '', tokens: 0, itemCount: 0 }
  if (estimateTokens(header) > maxTokens) return { text: '', tokens: 0, itemCount: 0 }

  const lines: string[] = []
  for (const hit of hits.slice(0, itemCap)) {
    if (hit.record.text.trim() === '') continue
    const line = memoryItemLine(hit, budget.publicBaseUrl)
    const candidate = `${header}\n${[...lines, line].join('\n')}`
    if (estimateTokens(candidate) > maxTokens) continue
    lines.push(line)
  }
  if (lines.length === 0) return { text: '', tokens: 0, itemCount: 0 }
  const text = `${header}\n${lines.join('\n')}`
  return { text, tokens: estimateTokens(text), itemCount: lines.length }
}
