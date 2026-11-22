import { createHash } from 'node:crypto'
import { MemoryError } from '../errors.js'
import type { CogneeMemoryConfig } from '../config/schema.js'
import {
  MEMORY_SCOPES,
  type AgentLike,
  type CallerIdentity,
  type MemoryScope,
  type ScopeRef,
} from '../types.js'

const MAX_RAW_ID_LENGTH = 512
const MAX_SLUG_LENGTH = 96
const HASH_LENGTH = 20
const LEGACY_HASH_LENGTH = 20

export function isMemoryScope(value: unknown): value is MemoryScope {
  return typeof value === 'string' && (MEMORY_SCOPES as readonly string[]).includes(value)
}

/**
 * Normalize a raw identity (principal id, agent preset, path, team id) before
 * turning it into a namespace segment. Raw ids may be long or contain
 * whitespace; they are never stored as-is.
 */
export function normalizeRawScopeId(raw: string): string {
  if (typeof raw !== 'string') {
    throw new MemoryError('VALIDATION', 'memory scope id must be a string')
  }
  const normalized = raw.trim().replace(/\s+/g, ' ')
  if (normalized.length === 0) {
    throw new MemoryError('VALIDATION', 'memory scope id must not be empty')
  }
  if (normalized.length > MAX_RAW_ID_LENGTH) {
    throw new MemoryError('VALIDATION', `memory scope id exceeds ${MAX_RAW_ID_LENGTH} characters`)
  }
  // Reject control characters so ids stay safe in dataset names and logs.
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new MemoryError('VALIDATION', 'memory scope id contains control characters')
  }
  return normalized
}

function shortHash(scope: MemoryScope, raw: string): string {
  return createHash('sha256')
    .update(`${scope}\u0000${raw}`)
    .digest('hex')
    .slice(0, HASH_LENGTH)
}

/**
 * Human-readable, deterministic namespace segment. It keeps as much of the
 * raw identity as is safe for a dataset name and appends a short hash when
 * normalization loses information, so two distinct ids cannot quietly merge.
 */
export function scopeIdFor(scope: MemoryScope, rawId: string): string {
  if (!isMemoryScope(scope)) {
    throw new MemoryError('VALIDATION', `unknown memory scope: ${String(scope)}`)
  }
  if (scope === 'global') return 'global'
  const normalized = normalizeRawScopeId(rawId)
  const slug = normalized
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
  const truncated = slug.length > MAX_SLUG_LENGTH ? slug.slice(0, MAX_SLUG_LENGTH) : slug
  const stable = truncated === '' ? `x-${shortHash(scope, normalized)}` : truncated
  const lossy = truncated !== normalized.toLowerCase() || truncated !== slug
  return lossy ? `${stable}-${shortHash(scope, normalized)}` : stable
}

/** Build one scope reference for a raw identity. */
export function makeScopeRef(scope: MemoryScope, rawId: string): ScopeRef {
  const id = scopeIdFor(scope, rawId)
  if (scope === 'global') return Object.freeze({ scope, id: 'global' })
  // M1 used a hashed name; keep it for read-only compatibility, never for writes.
  const legacyHash = createHash('sha256')
    .update(`${scope}\u0000${normalizeRawScopeId(rawId)}`)
    .digest('hex')
    .slice(0, LEGACY_HASH_LENGTH)
  const legacyName = `dsh_cognee_${scope}_${scope}-${legacyHash}`
  // Non-enumerable: adapters may read it for M1 compatibility, but tool-value
  // serialization never exposes it and DSH's strict output schema stays valid.
  const ref: { scope: MemoryScope; id: string; legacyName?: string } = { scope, id }
  Object.defineProperty(ref, 'legacyName', { value: legacyName, enumerable: false })
  return Object.freeze(ref)
}

export function globalScope(): ScopeRef {
  return Object.freeze({ scope: 'global', id: 'global' })
}

/**
 * Backend dataset/namespace key. This is the exact durable namespace scheme:
 * `dsh-session-…` is ephemeral, and `dsh-user-…`, `dsh-agent-…`,
 * `dsh-project-…`, `dsh-team-…`, `dsh-global` are durable.
 */
export function scopeKey(ref: ScopeRef): string {
  if (ref.scope === 'global') return 'dsh-global'
  return `dsh-${ref.scope}-${ref.id}`
}

/** M1 dataset name for read-only compatibility. */
export function legacyScopeKey(ref: ScopeRef): string | undefined {
  return ref.legacyName
}

export function sameScope(a: ScopeRef, b: ScopeRef): boolean {
  return a.scope === b.scope && a.id === b.id
}

export function formatScope(ref: ScopeRef): string {
  return `${ref.scope}:${ref.id}`
}

/**
 * Scopes a caller belongs to, narrowest first. Session memory is ephemeral and
 * keyed by the DSH session only; nothing durable is derived from a session id.
 * Global is absent unless the deployment explicitly opts in.
 */
export function scopesForIdentity(
  identity: CallerIdentity,
  config: CogneeMemoryConfig,
  cwd: string = process.cwd(),
): ScopeRef[] {
  const scopes: ScopeRef[] = []
  if (identity.sessionId !== undefined && identity.sessionId !== '') {
    scopes.push(makeScopeRef('session', identity.sessionId))
  }
  const agentId = identity.agentId ?? identity.agentPreset ?? config.identity.agentId
  if (agentId !== undefined && agentId !== '') {
    scopes.push(makeScopeRef('agent', agentId))
  }
  const principalId = identity.principalId
  if (principalId !== undefined && principalId !== '') {
    scopes.push(makeScopeRef('user', principalId))
  }
  const projectId = identity.projectId ?? config.scopeDefaults.projectId ?? cwd
  if (projectId !== '') {
    scopes.push(makeScopeRef('project', projectId))
  }
  const teamId = identity.teamId ?? config.scopeDefaults.teamId
  if (teamId !== undefined && teamId !== '') {
    scopes.push(makeScopeRef('team', teamId))
  }
  if (config.scopes.allowGlobal) scopes.push(globalScope())
  return scopes
}

/**
 * Identity from a live DSH agent. `agent.session.id` is only ever used for the
 * ephemeral session scope; the durable agent scope comes from the committed
 * session header's `agentPreset`, never from the session id.
 */
export function identityFromAgent(agent: AgentLike | undefined): CallerIdentity {
  const rawSession = agent?.session?.id
  const sessionId =
    typeof rawSession === 'string'
      ? rawSession
      : typeof rawSession === 'number' || typeof rawSession === 'bigint'
        ? String(rawSession)
        : undefined
  if (sessionId === undefined) return {}
  const header = (agent?.session as { readonly header?: { readonly agentPreset?: unknown } } | undefined)
    ?.header
  const preset = header?.agentPreset
  return {
    sessionId,
    ...(typeof preset === 'string' && preset !== '' ? { agentPreset: preset } : {}),
  }
}

/**
 * Resolve a model-supplied scope name against the caller's verified scopes.
 * Scope names are not authorization: the returned ref is the caller's own.
 * Global requires explicit deployment opt-in (`scopes.allowGlobal`).
 */
export function scopeFromName(
  name: unknown,
  identity: CallerIdentity,
  config: CogneeMemoryConfig,
): ScopeRef | undefined {
  if (name === undefined) return undefined
  if (!isMemoryScope(name)) {
    throw new MemoryError(
      'VALIDATION',
      'scope must be one of session, agent, user, project, team, global',
    )
  }
  if (name === 'global') {
    if (!config.scopes.allowGlobal) {
      throw new MemoryError('FORBIDDEN', 'global memory scope is not enabled on this deployment')
    }
    return globalScope()
  }
  const found = scopesForIdentity(identity, config).find((scope) => scope.scope === name)
  if (found === undefined) {
    throw new MemoryError('FORBIDDEN', `caller has no ${name} memory scope`)
  }
  return found
}
