/**
 * CLI runtime assembly for `memory import-history` / `memory export` /
 * `memory import`. It reuses the plugin's own settings precedence
 * (stored file > environment > profile/default), adapter, write policy,
 * deduplication, and ledger — the CLI is not a second implementation of memory
 * semantics.
 */
import { createMemoryAdapter } from '../adapters/memory-adapter.js'
import { parseConfig, type CogneeMemoryConfig } from '../config/schema.js'
import { MemoryCoordinator } from '../memory/coordinator.js'
import { MemoryLedger, resolveLedgerPath } from '../memory/ledger.js'
import { isMemoryScope, makeScopeRef, scopeKey, scopesForIdentity } from '../memory/scopes.js'
import { SettingsStore, resolveSettingsPath } from '../settings/store.js'
import { MemoryError } from '../errors.js'
import type { CallerIdentity, MemoryAdapter, MemoryScope, ScopeRef } from '../types.js'

export interface CliRuntime {
  readonly config: CogneeMemoryConfig
  readonly adapter: MemoryAdapter
  readonly ledger: MemoryLedger
  readonly coordinator: MemoryCoordinator
}

/** Config with the plugin's documented precedence; the CLI never writes settings. */
export function loadCliConfig(env: NodeJS.ProcessEnv = process.env): CogneeMemoryConfig {
  const store = new SettingsStore({
    filePath: resolveSettingsPath(env),
    baseConfig: parseConfig({ enabled: true }),
    env,
  })
  return store.current()
}

export function createCliRuntime(env: NodeJS.ProcessEnv = process.env): CliRuntime {
  const config = loadCliConfig(env)
  const endpoint = (): string => config.apiBaseUrl
  const adapter = createMemoryAdapter({ config, env, endpoint })
  const ledger = new MemoryLedger({ filePath: resolveLedgerPath(env) })
  const coordinator = new MemoryCoordinator({ adapter, config, endpoint, ledger })
  return { config, adapter, ledger, coordinator }
}

/** Default target scope when `--scope` is omitted. */
export function defaultScope(config: CogneeMemoryConfig, env: NodeJS.ProcessEnv = process.env): ScopeRef {
  const projectId = config.scopeDefaults.projectId?.trim() || env.DSH_MEMORY_PROJECT?.trim()
  if (projectId === undefined || projectId === '') {
    throw new MemoryError('VALIDATION', 'no target scope: pass --scope <name:rawId> or set scopeDefaults.projectId')
  }
  return makeScopeRef('project', projectId)
}

/**
 * Parse `--scope`. Accepts `name:rawId` and, for the scope name alone, the
 * deployment defaults (project id, team id, principal, agent preset, global).
 */
export function parseScopeArg(
  raw: string | undefined,
  config: CogneeMemoryConfig,
  env: NodeJS.ProcessEnv = process.env,
): ScopeRef {
  if (raw === undefined || raw.trim() === '') return defaultScope(config, env)
  const value = raw.trim()
  const index = value.indexOf(':')
  const name = index < 0 ? value : value.slice(0, index)
  if (!isMemoryScope(name)) {
    throw new MemoryError('VALIDATION', `unknown memory scope: ${name}`)
  }
  if (index >= 0) {
    const id = value.slice(index + 1).trim()
    if (id === '') throw new MemoryError('VALIDATION', 'scope id must not be empty')
    return makeScopeRef(name as MemoryScope, id)
  }
  switch (name) {
    case 'global':
      return makeScopeRef('global', 'global')
    case 'project': {
      const id = config.scopeDefaults.projectId?.trim() || env.DSH_MEMORY_PROJECT?.trim()
      if (id === undefined || id === '') {
        throw new MemoryError('VALIDATION', 'project scope needs an explicit id: --scope project:<rawId>')
      }
      return makeScopeRef('project', id)
    }
    case 'team': {
      const id = config.scopeDefaults.teamId?.trim()
      if (id === undefined || id === '') {
        throw new MemoryError('VALIDATION', 'team scope needs an explicit id: --scope team:<rawId>')
      }
      return makeScopeRef('team', id)
    }
    case 'user': {
      const id = env.DSH_MEMORY_PRINCIPAL?.trim()
      if (id === undefined || id === '') {
        throw new MemoryError('VALIDATION', 'user scope needs an explicit id: --scope user:<rawId>')
      }
      return makeScopeRef('user', id)
    }
    case 'agent': {
      const id = config.identity.agentId?.trim()
      if (id === undefined || id === '') {
        throw new MemoryError('VALIDATION', 'agent scope needs an explicit id: --scope agent:<rawId>')
      }
      return makeScopeRef('agent', id)
    }
    default:
      throw new MemoryError('VALIDATION', `session scope is ephemeral and cannot be targeted: ${name}`)
  }
}

/** Identity whose matching scope field is the target scope's raw id. */
export function identityForScope(
  scope: ScopeRef,
  options: { readonly sessionId?: string; readonly principalId?: string } = {},
): CallerIdentity {
  return {
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.principalId === undefined ? {} : { principalId: options.principalId }),
    ...(scope.scope === 'agent' ? { agentId: scope.id } : {}),
    ...(scope.scope === 'project' ? { projectId: scope.id } : {}),
    ...(scope.scope === 'team' ? { teamId: scope.id } : {}),
  }
}

/** Durable namespaces the caller resolved identity may address. */
export function allowedScopes(
  identity: CallerIdentity,
  config: CogneeMemoryConfig,
  cwd: string = process.cwd(),
): ScopeRef[] {
  return scopesForIdentity(identity, config, cwd).filter((scope) => scope.scope !== 'session')
}

/** Report line for a scope: `project:dsh/project/x -> dsh-project-…`. */
export function describeScope(scope: ScopeRef): string {
  return `${scope.scope}:${scope.id} -> ${scopeKey(scope)}`
}
