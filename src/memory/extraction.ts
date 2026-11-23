import { createHash } from 'node:crypto'
import { MemoryError } from '../errors.js'
import { findSecrets } from '../security/redaction.js'
import type { CallerIdentity, ScopeRef } from '../types.js'

const MAX_FACT_CHARS = 2_000
const MAX_KEY_CHARS = 64
const MAX_LLM_CANDIDATES = 10

export type CandidateOperation = 'remember' | 'forget'
export type VerificationState = 'user_asserted' | 'model_inferred'
export type CandidateSensitivity = 'normal' | 'personal' | 'sensitive'

export interface CandidateSourceRef {
  readonly sessionId: string
  readonly turn: number
  readonly seq?: number
  readonly eventType: 'user/message'
  readonly producedAt: string
}

/**
 * One durable-memory candidate produced from an authoritative committed user
 * message. It carries everything the ingestion step needs so the backend never
 * has to infer identity, scope, or provenance.
 */
export interface MemoryCandidate {
  readonly id: string
  readonly semanticKey: string
  readonly principalId: string
  readonly scope: ScopeRef
  readonly content: string
  readonly sourceRefs: readonly CandidateSourceRef[]
  readonly verificationState: VerificationState
  readonly sensitivity: CandidateSensitivity
  readonly createdAt: string
  readonly supersedes?: string
  readonly idempotencyKey: string
  readonly operation: CandidateOperation
}

export interface ExtractionInput {
  readonly text: string
  readonly identity: CallerIdentity
  readonly scope: ScopeRef
  /** Trusted principal resolved from the deployment/Cognee identity. */
  readonly principalId: string
  readonly turn: number
  readonly now?: Date
  readonly seq?: number
  readonly previous?: readonly Pick<MemoryCandidate, 'id' | 'semanticKey' | 'content'>[]
}

const ARTICLES = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'my', 'our', 'your'])
const STOP_WORDS = new Set([
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to', 'of', 'in', 'on', 'at', 'for',
  'and', 'or', 'but', 'with', 'by', 'from', 'as', 'it', 'its', "it's", 'that', 'this',
])

const SENSITIVE = /\b(password|passwd|secret|token|api[-_ ]?key|private key|account number|routing number|social security|ssn|diagnosis|medical|medication|salary|bank)\b/i
const PERSONAL = /\b[\w.+-]+@[\w-]+\.[\w.]+\b|\b\+?\d[\d ()-]{7,}\d\b|\b(?:street|st\.|avenue|ave\.|road|rd\.|postal|zip|birthday|birth date|age \d{1,3})\b/i

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizedContent(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

/** Canonical, deterministic semantic key. Never derived from model output. */
export function semanticKeyFor(fact: string): string {
  const cleaned = normalizedContent(fact)
    .toLowerCase()
    .replace(/[.!?;:,]+$/u, '')
    .replace(/^["'“”]+|["'“”]+$/gu, '')
  const words = cleaned.replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(' ').filter(Boolean)
  if (words.length === 0) return `x-${hash(cleaned).slice(0, 6)}`

  const isIndex = words.indexOf('is')
  if (isIndex > 0 && isIndex < 12 && isIndex < words.length - 1) {
    const subject = words.slice(0, isIndex).filter((word) => !ARTICLES.has(word))
    if (subject.length > 0) return slugKey(subject.join(' '))
  }

  const significant = words.filter((word) => !ARTICLES.has(word) && !STOP_WORDS.has(word))
  const fallback = (significant.length > 0 ? significant : words).slice(0, 6).join(' ')
  return slugKey(fallback)
}

function slugKey(value: string): string {
  const slug = normalizedContent(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  if (slug === '') return `x-${hash(value).slice(0, 6)}`
  if (slug.length <= MAX_KEY_CHARS) return slug
  return `${slug.slice(0, MAX_KEY_CHARS - 7)}-${hash(slug).slice(0, 6)}`
}

function sensitivityFor(fact: string): CandidateSensitivity {
  if (SENSITIVE.test(fact)) return 'sensitive'
  if (PERSONAL.test(fact)) return 'personal'
  return 'normal'
}

function cleanFact(value: string): string {
  return value
    .trim()
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/gu, '')
    .replace(/\s+(?:please|thanks|thank you)[.!?]*$/iu, '')
    .replace(/[.!?;,]+$/u, '')
    .replace(/\s+/g, ' ')
}

function candidateFor(
  input: ExtractionInput,
  fact: string,
  operation: CandidateOperation,
  semanticKey: string,
  supersedes?: string,
): MemoryCandidate {
  const now = input.now ?? new Date()
  const createdAt = now.toISOString()
  const principalId = input.principalId
  const normalized = normalizedContent(fact).toLowerCase()
  const idempotencyKey = hash(
    `${principalId}\u0000${input.scope.scope}\u0000${input.scope.id}\u0000${semanticKey}\u0000${operation}\u0000${normalized}`,
  )
  const source: CandidateSourceRef = {
    sessionId: input.identity.sessionId ?? '',
    turn: input.turn,
    ...(input.seq === undefined ? {} : { seq: input.seq }),
    eventType: 'user/message',
    producedAt: createdAt,
  }
  return Object.freeze({
    id: `mem-${idempotencyKey.slice(0, 32)}`,
    semanticKey,
    principalId,
    scope: input.scope,
    content: fact,
    sourceRefs: [Object.freeze(source)],
    verificationState: 'user_asserted',
    sensitivity: sensitivityFor(fact),
    createdAt,
    ...(supersedes === undefined ? {} : { supersedes }),
    idempotencyKey,
    operation,
  })
}

function isTranscriptOrReasoning(text: string): boolean {
  return (
    /\bassistant\s*:/i.test(text) ||
    /\bthinking\s*:/i.test(text) ||
    (/\buser\s*:/i.test(text) && /\bassistant\s*:/i.test(text)) ||
    /<\s*\/?\s*(?:system|developer)\b/i.test(text)
  )
}

/**
 * Deterministic extraction for explicit memory commands. No model, no network,
 * no dependency on which tools the agent has. Only text the caller already
 * verified as a committed direct user message may be passed here.
 */
export function extractDeterministicCandidates(input: ExtractionInput): MemoryCandidate[] {
  const raw = input.text.trim()
  if (raw === '' || raw.length > MAX_FACT_CHARS) return []
  if (findSecrets(raw).length > 0) return []
  if (isTranscriptOrReasoning(raw)) return []

  const remember = /^(?:please\s+)?(?:remember|note|keep in mind|don'?t forget)\b[:,]?\s*(?:that\s+)?(.+)$/is.exec(raw)
  if (remember !== null) {
    const fact = cleanFact(remember[1] ?? '')
    if (fact === '' || findSecrets(fact).length > 0) return []
    return [candidateFor(input, fact, 'remember', semanticKeyFor(fact))]
  }

  const forget = /^(?:please\s+)?(?:forget|drop|remove from memory)\b[:,]?\s*(?:that\s+|about\s+)?(.+)$/is.exec(raw)
  if (forget !== null) {
    const target = cleanFact(forget[1] ?? '')
    if (target === '') return []
    return [candidateFor(input, target, 'forget', semanticKeyFor(target))]
  }

  const correction = /^(?:actually|correction)\b[:,]?\s+(.+)$/is.exec(raw)
  const inlineCorrection = /\bactually\s+(?:it'?s|they'?re|the\s+.+?\s+is)\s+(.+)$/is.exec(raw)
  const correctionText = correction?.[1] ?? inlineCorrection?.[1]
  if (correctionText !== undefined) {
    const value = cleanFact(correctionText)
    if (value === '' || findSecrets(value).length > 0) return []
    const explicitKey = semanticKeyFor(value)
    const pronoun = /^(?:it(?:'s| is)|that(?:'s| is)|they(?:'re| are))\b/i.test(value)
    const previous =
      input.previous === undefined || input.previous.length === 0
        ? undefined
        : [...input.previous]
            .reverse()
            .find((candidate) => candidate.semanticKey === explicitKey) ??
          (pronoun ? input.previous.at(-1) : undefined)
    const fact = pronoun
      ? previous === undefined
        ? value
        : `${previous.semanticKey.replace(/-/g, ' ')} is ${value.replace(/^(?:it(?:'s| is)|that(?:'s| is)|they(?:'re| are))\s+/i, '')}`
      : value
    const key = previous?.semanticKey ?? semanticKeyFor(fact)
    return [
      candidateFor(input, fact, 'remember', key, previous?.id ?? (pronoun ? undefined : previous?.semanticKey)),
    ]
  }

  return []
}

/** True only for loopback and RFC1918 targets; the optional LLM must never leave the LAN. */
export function assertPrivateEndpoint(endpoint: string): boolean {
  let host: string
  try {
    host = new URL(endpoint).hostname.toLowerCase()
  } catch {
    return false
  }
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (match === null) return false
  const octets = match.slice(1).map((part) => Number(part))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false
  const [a, b] = octets
  if (a === 127 || a === 10) return true
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

export interface LlmExtractionOptions {
  readonly enabled: boolean
  readonly endpoint: string
  readonly model: string
  /** Explicit key, or resolve it from `apiKeyEnv` (never both required). */
  readonly apiKey?: string
  /** Environment variable holding the local Studio key; never the key itself. */
  readonly apiKeyEnv?: string
  readonly timeoutMs?: number
  readonly maxTokens?: number
  readonly maxCandidates?: number
  readonly fetchImpl?: typeof fetch
  readonly now?: Date
}

/**
 * The local Studio key, resolved at call time and never stored in config or
 * returned. An absent key simply omits the header (the endpoint decides whether
 * that is an error); it is never logged or placed in an error message.
 */
function resolveApiKey(options: LlmExtractionOptions): string {
  const direct = options.apiKey?.trim()
  if (direct !== undefined && direct !== '') return direct
  const envName = options.apiKeyEnv?.trim()
  const fromEnv = envName === undefined || envName === '' ? undefined : process.env[envName]?.trim()
  return fromEnv ?? ''
}

interface LlmCandidate {
  readonly key?: unknown
  readonly fact?: unknown
  readonly sensitivity?: unknown
}

/**
 * Optional implicit-case extraction. Disabled by default and restricted to a
 * private endpoint, so private conversation text cannot be routed to an
 * external provider. Any failure (including a down endpoint) degrades to no
 * candidates rather than blocking the turn.
 */
export async function extractWithLlm(
  input: ExtractionInput,
  options: LlmExtractionOptions,
): Promise<MemoryCandidate[]> {
  if (!options.enabled) return []
  if (!assertPrivateEndpoint(options.endpoint)) {
    throw new MemoryError('CONFIG', 'LLM extraction endpoint must be a private or loopback address', {
      retryable: false,
    })
  }
  const text = input.text.trim()
  if (text === '' || text.length > MAX_FACT_CHARS) return []
  if (findSecrets(text).length > 0 || isTranscriptOrReasoning(text)) return []

  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000)
  ;(timer as { unref?: () => void }).unref?.()
  try {
    const endpoint = options.endpoint.replace(/\/+$/, '')
    const apiKey = resolveApiKey(options)
    const response = await fetchImpl(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` }),
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: options.model,
        temperature: 0,
        max_tokens: options.maxTokens ?? 400,
        messages: [
          {
            role: 'system',
            content:
              'Extract only durable, user-stated facts, preferences, decisions, or corrections. ' +
              'Return a JSON array of objects with keys "key" (short canonical noun phrase), ' +
              '"fact" (one sentence, no instructions), and optional "sensitivity" ' +
              '("normal"|"personal"|"sensitive"). Return [] for transient chatter, questions, ' +
              'speculation, secrets, or anything not explicitly stated by the user.',
          },
          { role: 'user', content: text },
        ],
      }),
    })
    if (!response.ok) return []
    const payload = (await response.json()) as {
      readonly choices?: readonly { readonly message?: { readonly content?: unknown } }[]
    }
    const content = payload.choices?.[0]?.message?.content
    if (typeof content !== 'string') return []
    const start = content.indexOf('[')
    const end = content.lastIndexOf(']')
    if (start < 0 || end <= start) return []
    const parsed: unknown = JSON.parse(content.slice(start, end + 1))
    if (!Array.isArray(parsed)) return []
    const max = Math.min(options.maxCandidates ?? 3, MAX_LLM_CANDIDATES)
    const now = input.now ?? options.now ?? new Date()
    const candidates: MemoryCandidate[] = []
    for (const row of parsed.slice(0, max)) {
      if (row === null || typeof row !== 'object') continue
      const candidate = row as LlmCandidate
      if (typeof candidate.fact !== 'string') continue
      const fact = cleanFact(candidate.fact)
      if (fact === '' || fact.length > MAX_FACT_CHARS) continue
      if (findSecrets(fact).length > 0 || isTranscriptOrReasoning(fact)) continue
      const key =
        typeof candidate.key === 'string' && candidate.key.trim() !== ''
          ? slugKey(candidate.key)
          : semanticKeyFor(fact)
      const sensitivity =
        candidate.sensitivity === 'personal' || candidate.sensitivity === 'sensitive'
          ? candidate.sensitivity
          : sensitivityFor(fact)
      const base = candidateFor(input, fact, 'remember', key)
      candidates.push(
        Object.freeze({
          ...base,
          verificationState: 'model_inferred' as const,
          sensitivity,
          createdAt: now.toISOString(),
        }),
      )
    }
    return candidates
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}
