/**
 * Redaction v2: an LLM PII pass that runs *after* deterministic secret
 * redaction and *before* anything is written to Cognee.
 *
 * Two properties matter more than detection quality:
 *
 * 1. **Stable placeholders.** The same person becomes `PERSON_1` everywhere in
 *    a batch, so archived text stays coherent and later recall can still see
 *    that one actor did both things. Numbering is assigned per value, not per
 *    occurrence.
 * 2. **The map never leaves the host.** `PlaceholderMap` is written to the
 *    plugin state directory (0600) encrypted with AES-256-GCM when a key is
 *    available, and is never included in the text handed to the adapter. Only
 *    placeholders travel.
 *
 * Detection is deliberately a *model* call rather than a regex pile: names,
 * addresses and third-party identifiers have no reliable shape. That makes the
 * pass lossy and fallible, which is why `docs/REDACTION_POLICY.md` states what
 * it cannot catch and the pipeline re-scans for secrets afterwards.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { findSecrets } from './redaction.js'

/** Entity classes the PII pass is allowed to emit. */
export type PiiKind = 'PERSON' | 'ADDR' | 'PHONE' | 'EMAIL' | 'ORG' | 'ID'

const KINDS: readonly PiiKind[] = ['PERSON', 'ADDR', 'PHONE', 'EMAIL', 'ORG', 'ID']

/** One model-reported entity. */
export interface PiiEntity {
  readonly kind: PiiKind
  readonly value: string
}

/** One applied replacement. `value` is local-only and must never be logged. */
export interface PiiFinding {
  readonly kind: PiiKind
  readonly value: string
  readonly placeholder: string
}

/** Environment variable holding the placeholder-map key. */
export const PII_MAP_KEY_ENV = 'COGNEE_PII_MAP_KEY'

export function resolvePiiMapPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.COGNEE_PII_MAP_FILE?.trim()
  if (explicit !== undefined && explicit !== '') return explicit
  const home = env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'plugins', 'cognee-memory', 'pii-map.enc.json')
}

function isKind(value: unknown): value is PiiKind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value)
}

/** value -> placeholder, with a per-kind counter. Local only. */
export class PlaceholderMap {
  private readonly byValue = new Map<string, string>()
  private readonly counters = new Map<PiiKind, number>()

  /** Assign a stable placeholder, reusing the one already bound to `value`. */
  assign(kind: PiiKind, value: string): string {
    const existing = this.byValue.get(`${kind}\u0000${value}`)
    if (existing !== undefined) return existing
    const next = (this.counters.get(kind) ?? 0) + 1
    this.counters.set(kind, next)
    const placeholder = `${kind}_${next}`
    this.byValue.set(`${kind}\u0000${value}`, placeholder)
    return placeholder
  }

  /** Placeholder for a value, or undefined when it was never seen. */
  lookup(kind: PiiKind, value: string): string | undefined {
    return this.byValue.get(`${kind}\u0000${value}`)
  }

  get size(): number {
    return this.byValue.size
  }

  /** Local-only view; never serialized into memory text. */
  entries(): { kind: PiiKind; value: string; placeholder: string }[] {
    return [...this.byValue.entries()].map(([key, placeholder]) => {
      const [kind, value] = key.split('\u0000')
      return { kind: kind as PiiKind, value: value ?? '', placeholder }
    })
  }

  toJSON(): { version: 1; counters: Record<string, number>; entries: { kind: PiiKind; value: string; placeholder: string }[] } {
    return { version: 1, counters: Object.fromEntries(this.counters), entries: this.entries() }
  }

  static fromJSON(value: unknown): PlaceholderMap {
    const map = new PlaceholderMap()
    if (value === null || typeof value !== 'object') return map
    const row = value as Record<string, unknown>
    const entries = Array.isArray(row.entries) ? row.entries : []
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') continue
      const item = entry as Record<string, unknown>
      if (!isKind(item.kind) || typeof item.value !== 'string' || typeof item.placeholder !== 'string') continue
      map.byValue.set(`${item.kind}\u0000${item.value}`, item.placeholder)
      const number = Number.parseInt(item.placeholder.split('_').at(-1) ?? '0', 10)
      if (Number.isFinite(number)) {
        map.counters.set(item.kind, Math.max(map.counters.get(item.kind) ?? 0, number))
      }
    }
    return map
  }
}

/** Resolve the 32-byte AES key: env passphrase, else a generated local key file. */
export function resolveMapKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env[PII_MAP_KEY_ENV]?.trim()
  if (raw !== undefined && raw !== '') {
    if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex')
    return scryptSync(raw, 'dsh-cognee-pii-map', 32)
  }
  const keyPath = `${resolvePiiMapPath(env)}.key`
  if (existsSync(keyPath)) return Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'hex')
  const key = randomBytes(32)
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 })
  writeFileSync(keyPath, key.toString('hex'), { encoding: 'utf8', mode: 0o600 })
  return key
}

/** AES-256-GCM envelope. The plaintext map is never written to disk. */
export function encryptMap(map: PlaceholderMap, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(JSON.stringify(map.toJSON()), 'utf8')
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return JSON.stringify({
    version: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: body.toString('base64'),
  })
}

export function decryptMap(envelope: string, key: Buffer): PlaceholderMap {
  const parsed = JSON.parse(envelope) as Record<string, unknown>
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(String(parsed.iv), 'base64'))
  decipher.setAuthTag(Buffer.from(String(parsed.tag), 'base64'))
  const plain = Buffer.concat([decipher.update(Buffer.from(String(parsed.data), 'base64')), decipher.final()])
  return PlaceholderMap.fromJSON(JSON.parse(plain.toString('utf8')))
}

/** Persist the map encrypted, atomically, 0600. */
export function saveMap(filePath: string, map: PlaceholderMap, key: Buffer): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.tmp-${process.pid}`
  writeFileSync(temporary, `${encryptMap(map, key)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, filePath)
}

/** Load the map, tolerating absence. A corrupt map fails closed to empty. */
export function loadMap(filePath: string, key: Buffer): PlaceholderMap {
  if (!existsSync(filePath)) return new PlaceholderMap()
  try {
    return decryptMap(readFileSync(filePath, 'utf8'), key)
  } catch {
    return new PlaceholderMap()
  }
}

const SYSTEM_PROMPT = [
  'You are a PII detector for an archival pipeline.',
  'Return ONLY JSON: {"entities":[{"kind":"PERSON|ADDR|PHONE|EMAIL|ORG|ID","value":"exact substring"}]}',
  'Include: person names, postal addresses, phone numbers, email addresses,',
  'organisation names, and third-party identifiers (account ids, ticket ids,',
  'customer ids, handles).',
  'Exclude: the assistant itself, product names, placeholders already of the',
  'form KIND_n, and anything that is not personal or identifying data.',
  'The value MUST appear verbatim in the input. When nothing matches return',
  '{"entities":[]}.',
].join(' ')

export interface DetectionOptions {
  readonly endpoint: string
  readonly model: string
  readonly apiKey?: string
  readonly timeoutMs?: number
  readonly fetchImpl?: typeof fetch
}

function parseEntities(body: string): PiiEntity[] {
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  const slice = start >= 0 && end > start ? body.slice(start, end + 1) : body
  let parsed: unknown
  try {
    parsed = JSON.parse(slice)
  } catch {
    return []
  }
  if (parsed === null || typeof parsed !== 'object') return []
  const list = (parsed as Record<string, unknown>).entities
  if (!Array.isArray(list)) return []
  const entities: PiiEntity[] = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    if (!isKind(row.kind) || typeof row.value !== 'string') continue
    const value = row.value.trim()
    if (value === '' || value.length > 200) continue
    // A model that returns a placeholder is echoing our own output.
    if (/^(?:PERSON|ADDR|PHONE|EMAIL|ORG|ID)_\d+$/.test(value)) continue
    entities.push({ kind: row.kind, value })
  }
  return entities
}

/** Ask the local model for PII entities. A transport failure yields no entities. */
export async function detectPii(text: string, options: DetectionOptions): Promise<PiiEntity[]> {
  const doFetch = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000)
  try {
    const response = await doFetch(`${options.endpoint.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(options.apiKey === undefined ? {} : { Authorization: `Bearer ${options.apiKey}` }),
      },
      body: JSON.stringify({
        model: options.model,
        temperature: 0,
        max_tokens: 1024,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
      }),
      signal: controller.signal,
    })
    if (!response.ok) return []
    const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] }
    const content = payload.choices?.[0]?.message?.content ?? ''
    return parseEntities(content)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Replace every entity with its stable placeholder. Longest match wins so
 * "Dana Whitfield" is not partially replaced by "Dana". Non-overlapping.
 */
export function applyPlaceholders(
  text: string,
  entities: readonly PiiEntity[],
  map: PlaceholderMap,
): { readonly text: string; readonly findings: readonly PiiFinding[] } {
  const usable = entities
    .filter((entity) => entity.value !== '' && text.includes(entity.value))
    .sort((a, b) => b.value.length - a.value.length)
  const taken: { start: number; end: number }[] = []
  const replacements: { start: number; end: number; placeholder: string; entity: PiiEntity }[] = []
  for (const entity of usable) {
    let from = 0
    for (;;) {
      const index = text.indexOf(entity.value, from)
      if (index < 0) break
      const end = index + entity.value.length
      const overlaps = taken.some((range) => index < range.end && range.start < end)
      if (!overlaps) {
        taken.push({ start: index, end })
        replacements.push({ start: index, end, placeholder: map.assign(entity.kind, entity.value), entity })
      }
      from = end
    }
  }
  replacements.sort((a, b) => a.start - b.start)
  let output = ''
  let cursor = 0
  const findings: PiiFinding[] = []
  for (const replacement of replacements) {
    output += text.slice(cursor, replacement.start)
    output += replacement.placeholder
    cursor = replacement.end
    findings.push({ kind: replacement.entity.kind, value: replacement.entity.value, placeholder: replacement.placeholder })
  }
  output += text.slice(cursor)
  return { text: output, findings }
}
