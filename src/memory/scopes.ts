import { createHash } from 'node:crypto'
import { MemoryError } from '../errors.js'
import type { CogneeMemoryConfig } from '../config/schema.js'
import { MEMORY_SCOPES, type AgentLike, type CallerIdentity, type MemoryScope, type ScopeRef } from '../types.js'

const MAX_RAW_ID_LENGTH = 512
const HASH_LENGTH = 20

export function isMemoryScope(value: unknown): value is MemoryScope {
  return typeof value === 'string' && (MEMORY_SCOPES as readonly string[]).includes(value)
}

/**
 * Normalize a raw identity (session id, path, team id) before hashing.
 * Raw ids may be long or contain whitespace; they are never stored as-is.
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

/** Stable, opaque scope key derived from a raw id; the raw id is not recoverable. */
export function scopeIdFor(scope: MemoryScope, rawId: string): string {
  if (!isMemoryScope(scope)) {
    throw new MemoryError('VALIDATION', `unknown memory scope: ${String(scope)}`)
  }
  if (scope === 'global') return 'global'
  const normalized = normalizeRawScopeId(rawId)
  const digest = createHash('sha256').update(`${scope}\u0000${normalized}`).digest('hex')
  return `${scope}-${digest.slice(0, HASH_LENGTH)}`
}

/** Build one scope reference for a raw identity. */
export function makeScopeRef(scope: MemoryScope, rawId: string): ScopeRef {
  return Object.freeze({ scope, id: scopeIdFor(scope, rawId) })
}

export function globalScope(): ScopeRef {
  return Object.freeze({ scope: 'global', id: 'global' })
}

/** Backend dataset/namespace key. Kept in one place so adapters never invent one. */
export function scopeKey(ref: ScopeRef): string {
  return `dsh_cognee_${ref.scope}_${ref.id}`
}

export function sameScope(a: ScopeRef, b: ScopeRef): boolean {
  return a.scope === b.scope && a.id === b.id
}

export function formatScope(ref: ScopeRef): string {
  return `${ref.scope}:${ref.id}`
}

/**
 * Scopes a caller belongs to. Global is always readable; the narrower scopes
 * require an identity. Project falls back to the configured project id and
 * then the working directory, giving a stable project scope per workspace.
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
  const agentId = identity.agentId ?? identity.sessionId
  if (agentId !== undefined && agentId !== '') {
    scopes.push(makeScopeRef('agent', agentId))
  }
  const projectId = identity.projectId ?? config.scopeDefaults.projectId ?? cwd
  if (projectId !== '') {
    scopes.push(makeScopeRef('project', projectId))
  }
  const teamId = identity.teamId ?? config.scopeDefaults.teamId
  if (teamId !== undefined && teamId !== '') {
    scopes.push(makeScopeRef('team', teamId))
  }
  scopes.push(globalScope())
  return scopes
}

/** Identity derived from a live DSH agent. Agent scope uses the session id in Phase 1. */
export function identityFromAgent(agent: AgentLike | undefined): CallerIdentity {
  const rawSession = agent?.session?.id
  const sessionId =
    typeof rawSession === 'string'
      ? rawSession
      : typeof rawSession === 'number' || typeof rawSession === 'bigint'
        ? String(rawSession)
        : undefined
  return sessionId === undefined ? {} : { sessionId, agentId: sessionId }
}

/**
 * Resolve a model-supplied scope name against the caller's verified scopes.
 * Scope names are not authorization: the returned ref is the caller's own.
 */
export function scopeFromName(
  name: unknown,
  identity: CallerIdentity,
  config: CogneeMemoryConfig,
): ScopeRef | undefined {
  if (name === undefined) return undefined
  if (!isMemoryScope(name)) {
    throw new MemoryError('VALIDATION', 'scope must be one of session, agent, project, team, global')
  }
  if (name === 'global') return globalScope()
  const found = scopesForIdentity(identity, config).find((scope) => scope.scope === name)
  if (found === undefined) {
    throw new MemoryError('FORBIDDEN', `caller has no ${name} memory scope`)
  }
  return found
}
