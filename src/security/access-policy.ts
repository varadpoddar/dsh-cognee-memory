import { MemoryError } from '../errors.js'
import type { CogneeMemoryConfig } from '../config/schema.js'
import { sameScope } from '../memory/scopes.js'
import type { ScopeRef } from '../types.js'

export interface AccessPolicyOptions {
  /** Scopes that may receive writes; defaults to the readable set. */
  readonly writeScopes?: readonly ScopeRef[]
}

function hasScope(scopes: readonly ScopeRef[], target: ScopeRef): boolean {
  return scopes.some((scope) => sameScope(scope, target))
}

/**
 * Deny-by-default scope authorization. Results returned by a backend are
 * filtered through this policy, so extra rows from another session, agent,
 * project, team, or tenant never reach the model.
 */
export class AccessPolicy {
  private readonly readable: readonly ScopeRef[]
  private readonly writable: readonly ScopeRef[]

  constructor(readableScopes: readonly ScopeRef[], options: AccessPolicyOptions = {}) {
    this.readable = Object.freeze([...readableScopes])
    this.writable = Object.freeze([...(options.writeScopes ?? readableScopes)])
  }

  get readableScopes(): readonly ScopeRef[] {
    return this.readable
  }

  canRead(target: ScopeRef): boolean {
    return hasScope(this.readable, target)
  }

  canWrite(target: ScopeRef): boolean {
    return hasScope(this.writable, target)
  }

  assertReadable(target: ScopeRef): void {
    if (!this.canRead(target)) {
      throw new MemoryError('FORBIDDEN', `memory scope ${target.scope} is not accessible to this caller`)
    }
  }

  assertWritable(target: ScopeRef): void {
    if (!this.canWrite(target)) {
      throw new MemoryError('FORBIDDEN', `memory scope ${target.scope} is not writable by this caller`)
    }
  }

  /** Drop every item whose scope is outside the policy, preserving order. */
  filterReadable<T extends { readonly scope: ScopeRef }>(items: readonly T[]): T[] {
    return items.filter((item) => this.canRead(item.scope))
  }
}

export function buildAccessPolicy(
  callerScopes: readonly ScopeRef[],
  options: AccessPolicyOptions = {},
): AccessPolicy {
  return new AccessPolicy(callerScopes, options)
}
