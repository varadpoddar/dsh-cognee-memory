import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config/schema.js'
import { buildAccessPolicy } from '../src/security/access-policy.js'
import { CandidateQueue } from '../src/memory/candidate-queue.js'
import { extractDeterministicCandidates } from '../src/memory/extraction.js'
import { makeScopeRef, scopesForIdentity } from '../src/memory/scopes.js'
import { evaluateWrite } from '../src/memory/write-policy.js'
import { MemoryError } from '../src/errors.js'
import type { MemoryCandidate } from '../src/memory/extraction.js'
import type { Provenance } from '../src/types.js'

/**
 * Milestone 10 security matrix: authorization at the write/read boundary and
 * pre-write credential redaction. Route-level authorization (provenance 404,
 * token gating, no secret rendering) is covered by provenance-http.test.ts and
 * settings-http.test.ts; these tests cover the layer below the routes.
 */
const config = parseConfig({ scopeDefaults: { projectId: '/workspace/demo' } })
const redactConfig = parseConfig({
  scopeDefaults: { projectId: '/workspace/demo' },
  security: { redactionMode: 'redact' },
})
const identity = { sessionId: 's1', agentId: 's1', projectId: '/workspace/demo' }
const project = makeScopeRef('project', '/workspace/demo')
const foreignProject = makeScopeRef('project', '/workspace/other')
const policy = buildAccessPolicy(scopesForIdentity(identity, config))
const provenance: Provenance = {
  kind: 'tool_call',
  source: 'tool:memory_remember',
  recordedAt: '2026-01-01T00:00:00.000Z',
}

const FAKE_KEY = `sk-${'f'.repeat(32)}`
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhdHRhY2tlciJ9.c2lnbmF0dXJl'
const FAKE_PASSWORD = 'password = "hunter2-correct-horse"'
const FAKE_PEM =
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAfakekeymaterial\n-----END RSA PRIVATE KEY-----'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function write(text: string, overrides: Record<string, unknown> = {}) {
  return evaluateWrite({
    text,
    scope: project,
    provenance,
    policy,
    config,
    ...overrides,
  } as Parameters<typeof evaluateWrite>[0])
}

function candidate(content: string): MemoryCandidate {
  return {
    id: 'mem-secret-1',
    semanticKey: 'credential-note',
    principalId: 'p1',
    scope: project,
    content,
    sourceRefs: [
      { sessionId: 's1', turn: 1, eventType: 'user/message', producedAt: '2026-01-01T00:00:00.000Z' },
    ],
    verificationState: 'user_asserted',
    sensitivity: 'normal',
    createdAt: '2026-01-01T00:00:00.000Z',
    idempotencyKey: 'b'.repeat(64),
    operation: 'remember',
  }
}

describe('authorization matrix', () => {
  it('denies reads to an unauthorized principal', () => {
    const foreignRow = { id: 'mem-foreign', scope: foreignProject }
    expect(policy.filterReadable([foreignRow])).toEqual([])
    expect(() => policy.assertReadable(foreignProject)).toThrow(MemoryError)
    expect(policy.canRead(foreignProject)).toBe(false)
  })

  it('denies cross-scope writes even when the scope is readable', () => {
    const readOnly = buildAccessPolicy([project, foreignProject], { writeScopes: [project] })
    const decision = write('a durable decision', { scope: foreignProject, policy: readOnly })
    expect(decision).toMatchObject({ allowed: false, error: { code: 'FORBIDDEN' } })
  })

  it('denies writes without authoritative provenance', () => {
    const decision = write('a durable decision', {
      provenance: { kind: 'model_self_report', source: 'assistant', recordedAt: '2026-01-01T00:00:00.000Z' },
    })
    expect(decision).toMatchObject({ allowed: false, error: { code: 'VALIDATION' } })
  })

  it('refuses writes for an identity with no scopes at all', () => {
    const empty = buildAccessPolicy([])
    expect(write('anything at all', { policy: empty })).toMatchObject({
      allowed: false,
      error: { code: 'FORBIDDEN' },
    })
  })
})

describe('pre-write redaction', () => {
  it.each([
    ['openai key', `deploy key is ${FAKE_KEY}`],
    ['jwt', `session token ${FAKE_JWT}`],
    ['password assignment', `db ${FAKE_PASSWORD}`],
    ['private key', `here you go\n${FAKE_PEM}`],
  ])('blocks a %s before any write in reject mode', (_name, text) => {
    const decision = write(text)
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.error.code).toBe('REDACTION_BLOCKED')
      // The rejection reports kinds, never the matched value.
      expect(JSON.stringify({ message: decision.error.message, details: decision.error.details })).not.toContain(
        text.slice(-18),
      )
    }
  })

  it('redacts rather than blocks when redactionMode is redact', () => {
    const decision = write(`deploy target is blue and the key is ${FAKE_KEY}`, { config: redactConfig })
    expect(decision.allowed).toBe(true)
    if (decision.allowed) {
      expect(decision.text).toContain('deploy target is blue')
      expect(decision.text).not.toContain(FAKE_KEY)
      expect(decision.text).not.toContain('ffffffff')
      expect(decision.redacted).toBe(true)
    }
  })

  it('never leaks a secret through the write decision or its dedupe key', () => {
    const decision = write(`api key ${FAKE_KEY}`)
    expect(JSON.stringify(decision)).not.toContain(FAKE_KEY)
    expect(JSON.stringify(decision)).not.toContain('ffffffff')
  })
})

describe('extractor and queue refuse secrets', () => {
  it('produces no candidate from an extraction turn containing a secret', () => {
    const candidates = extractDeterministicCandidates({
      text: `remember that the production api key is ${FAKE_KEY}`,
      identity,
      scope: project,
      principalId: 'p1',
      turn: 1,
    })
    expect(candidates).toEqual([])
  })

  it('rejects a queued candidate carrying a secret with reason secret', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cognee-m10-'))
    dirs.push(dir)
    const queue = new CandidateQueue({ dir })
    expect(await queue.enqueue(candidate(`the jwt is ${FAKE_JWT}`))).toEqual({
      accepted: false,
      reason: 'secret',
    })
    expect(await queue.pending()).toEqual([])
  })
})
