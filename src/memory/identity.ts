import type { CogneeMemoryConfig } from '../config/schema.js'
import type { CallerIdentity, MemoryAdapter, ScopeRef } from '../types.js'
import { makeScopeRef, scopeKey, scopesForIdentity } from './scopes.js'

/** Deployment-supplied identity sources. No field is ever filled from model text. */
export const PRINCIPAL_ENV = 'DSH_MEMORY_PRINCIPAL'

export interface IdentityResolverOptions {
  readonly config: CogneeMemoryConfig
  readonly env?: NodeJS.ProcessEnv
  readonly cwd?: string
  /** Optional authenticated-principal probe (Cognee `/users/me` in the REST adapter). */
  readonly adapter?: Pick<MemoryAdapter, 'probePrincipal'>
  readonly now?: () => number
  /** Retry a failed/empty probe after this long; successful ids are kept for the process. */
  readonly probeRetryMs?: number
}

/**
 * Resolves the stable identity that namespaces are built from.
 *
 * Priority:
 *  1. `identity.principalId` from the deployment profile (trusted config).
 *  2. `DSH_MEMORY_PRINCIPAL` from the environment (trusted deployment env).
 *  3. The authenticated Cognee user behind the configured API key (`/users/me`).
 *
 * A DSH session id is never a principal. If none of these yield an id, durable
 * user/project/team scopes are unavailable and the caller still gets the
 * ephemeral session scope only.
 */
export class IdentityResolver {
  private readonly config: CogneeMemoryConfig
  private readonly env: NodeJS.ProcessEnv
  private readonly cwd: string
  private readonly adapter: Pick<MemoryAdapter, 'probePrincipal'> | undefined
  private readonly now: () => number
  private readonly probeRetryMs: number
  private cached: { readonly id: string | undefined; readonly at: number } | undefined

  constructor(options: IdentityResolverOptions) {
    this.config = options.config
    this.env = options.env ?? process.env
    this.cwd = options.cwd ?? process.cwd()
    this.adapter = options.adapter
    this.now = options.now ?? Date.now
    this.probeRetryMs = options.probeRetryMs ?? 30_000
  }

  /** Trusted principal id, or undefined when the deployment has no authenticated identity. */
  async principalId(): Promise<string | undefined> {
    const configured = this.config.identity.principalId?.trim()
    if (configured !== undefined && configured !== '') return configured
    const fromEnv = this.env[PRINCIPAL_ENV]?.trim()
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv
    if (this.cached !== undefined) {
      const fresh =
        this.cached.id !== undefined || this.now() - this.cached.at < this.probeRetryMs
      if (fresh) return this.cached.id
    }
    let id: string | undefined
    if (this.adapter?.probePrincipal !== undefined) {
      try {
        id = (await this.adapter.probePrincipal())?.trim() || undefined
      } catch {
        id = undefined
      }
    }
    this.cached = { id, at: this.now() }
    return id
  }

  /** Merge trusted identity into a caller identity without overwriting explicit test/deployment ids. */
  async resolve(identity: CallerIdentity = {}): Promise<CallerIdentity> {
    const principalId = identity.principalId ?? (await this.principalId())
    const agentId = identity.agentId ?? this.config.identity.agentId
    return {
      ...identity,
      ...(principalId === undefined || principalId === '' ? {} : { principalId }),
      ...(agentId === undefined || agentId === '' ? {} : { agentId }),
    }
  }

  async scopes(identity: CallerIdentity = {}): Promise<readonly ScopeRef[]> {
    return scopesForIdentity(await this.resolve(identity), this.config, this.cwd)
  }

  /** Durable namespaces this deployment can address. Session is deliberately absent. */
  async namespaces(identity: CallerIdentity = {}): Promise<Readonly<Record<string, string>>> {
    const resolved = await this.resolve(identity)
    const namespaces: Record<string, string> = {}
    const teamId = resolved.teamId ?? this.config.scopeDefaults.teamId
    const map: Array<[string, ScopeRef | undefined]> = [
      ['agent', resolved.agentId === undefined ? undefined : makeScopeRef('agent', resolved.agentId)],
      ['user', resolved.principalId === undefined ? undefined : makeScopeRef('user', resolved.principalId)],
      [
        'project',
        makeScopeRef('project', resolved.projectId ?? this.config.scopeDefaults.projectId ?? this.cwd),
      ],
      ['team', teamId === undefined ? undefined : makeScopeRef('team', teamId)],
      ['global', this.config.scopes.allowGlobal ? makeScopeRef('global', 'global') : undefined],
    ]
    for (const [name, scope] of map) {
      if (scope !== undefined) namespaces[name] = scopeKey(scope)
    }
    return namespaces
  }
}
