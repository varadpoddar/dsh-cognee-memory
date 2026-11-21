import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config/schema.js'
import { buildAccessPolicy } from '../src/security/access-policy.js'
import { makeScopeRef, scopesForIdentity } from '../src/memory/scopes.js'
import { evaluateWrite } from '../src/memory/write-policy.js'
import type { Provenance } from '../src/types.js'

const config = parseConfig({ scopeDefaults: { projectId: '/workspace/demo' } })
const identity = { sessionId: 's1', agentId: 's1', projectId: '/workspace/demo' }
const project = makeScopeRef('project', '/workspace/demo')
const session = makeScopeRef('session', 's1')
const policy = buildAccessPolicy(scopesForIdentity(identity, config))
const provenance: Provenance = {
  kind: 'tool_call',
  source: 'tool:memory_remember',
  recordedAt: '2026-01-01T00:00:00.000Z',
}

function evaluate(overrides: Record<string, unknown> = {}) {
  return evaluateWrite({
    text: 'durable decision',
    scope: project,
    provenance,
    policy,
    config,
    ...overrides,
  } as Parameters<typeof evaluateWrite>[0])
}

describe('write policy', () => {
  it('allows a clean write and computes a dedupe key', () => {
    const decision = evaluate()
    expect(decision).toMatchObject({ allowed: true, text: 'durable decision', redacted: false })
    if (decision.allowed) expect(decision.dedupeKey).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects when memory is disabled', () => {
    const disabled = parseConfig({ enabled: false })
    const decision = evaluate({ config: disabled })
    expect(decision).toMatchObject({ allowed: false, error: { code: 'DISABLED' } })
  })

  it('rejects empty and oversized text', () => {
    expect(evaluate({ text: '   ' })).toMatchObject({ allowed: false, error: { code: 'VALIDATION' } })
    expect(evaluate({ text: 'a'.repeat(config.security.maxTextChars + 1) })).toMatchObject({
      allowed: false,
      error: { code: 'VALIDATION' },
    })
  })

  it('rejects non-authoritative provenance', () => {
    const decision = evaluate({
      provenance: { kind: 'model_self_report', source: 'assistant', recordedAt: '2026-01-01T00:00:00.000Z' },
    })
    expect(decision).toMatchObject({ allowed: false, error: { code: 'VALIDATION' } })
  })

  it('rejects a scope the caller may not write', () => {
    const readOnly = buildAccessPolicy([project], { writeScopes: [session] })
    expect(evaluate({ policy: readOnly })).toMatchObject({
      allowed: false,
      error: { code: 'FORBIDDEN' },
    })
  })

  it('rejects secrets by default', () => {
    const decision = evaluate({ text: `key sk-${'a'.repeat(32)}` })
    expect(decision).toMatchObject({ allowed: false, error: { code: 'REDACTION_BLOCKED' } })
  })

  it('redacts secrets when configured to redact', () => {
    const redacting = parseConfig({ security: { redactionMode: 'redact' } })
    const decision = evaluate({ config: redacting, text: `key sk-${'a'.repeat(32)}` })
    expect(decision.allowed).toBe(true)
    if (decision.allowed) {
      expect(decision.redacted).toBe(true)
      expect(decision.text).toContain('[REDACTED:api_key]')
      expect(decision.text).not.toContain('sk-')
    }
  })
})
