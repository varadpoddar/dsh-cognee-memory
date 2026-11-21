import { MemoryError, isMemoryError } from '../errors.js'
import type { CogneeMemoryConfig } from '../config/schema.js'
import type { AccessPolicy } from '../security/access-policy.js'
import { guardForWrite } from '../security/redaction.js'
import type { Provenance, ScopeRef } from '../types.js'
import { dedupeKey } from './deduplication.js'
import { isAuthoritativeProvenance } from './provenance.js'

export interface WritePolicyInput {
  readonly text: string
  readonly scope: ScopeRef
  readonly provenance: Provenance
  readonly policy: AccessPolicy
  readonly config: CogneeMemoryConfig
}

export type WritePolicyDecision =
  | {
      readonly allowed: true
      readonly text: string
      readonly dedupeKey: string
      readonly redacted: boolean
    }
  | { readonly allowed: false; readonly error: MemoryError }

function deny(error: MemoryError): WritePolicyDecision {
  return { allowed: false, error }
}

/**
 * Decide whether text may become a durable memory. This is the single place
 * where enablement, scope write access, provenance authority, text bounds, and
 * credential redaction are enforced before any adapter call.
 */
export function evaluateWrite(input: WritePolicyInput): WritePolicyDecision {
  if (!input.config.enabled) {
    return deny(new MemoryError('DISABLED', 'cognee memory is disabled'))
  }
  const text = input.text.trim()
  if (text.length === 0) {
    return deny(new MemoryError('VALIDATION', 'memory text must not be empty'))
  }
  if (text.length > input.config.security.maxTextChars) {
    return deny(
      new MemoryError(
        'VALIDATION',
        `memory text exceeds the ${input.config.security.maxTextChars} character limit`,
      ),
    )
  }
  if (!isAuthoritativeProvenance(input.provenance)) {
    return deny(new MemoryError('VALIDATION', 'memory provenance is not authoritative'))
  }
  try {
    input.policy.assertWritable(input.scope)
  } catch (error) {
    return deny(isMemoryError(error) ? error : new MemoryError('FORBIDDEN', 'memory scope is not writable'))
  }
  try {
    const guarded = guardForWrite(text, input.config.security.redactionMode)
    return {
      allowed: true,
      text: guarded.text,
      dedupeKey: dedupeKey(input.scope, guarded.text),
      redacted: guarded.redacted,
    }
  } catch (error) {
    return deny(isMemoryError(error) ? error : new MemoryError('REDACTION_BLOCKED', 'memory write rejected'))
  }
}
