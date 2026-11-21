import { describe, expect, it } from 'vitest'
import { RedactionBlockedError } from '../src/errors.js'
import { findSecrets, guardForWrite, redactSecrets } from '../src/security/redaction.js'

const samples = {
  openai: `sk-${'a'.repeat(32)}`,
  github: `ghp_${'b'.repeat(30)}`,
  githubPat: `github_pat_${'c'.repeat(30)}`,
  aws: 'AKIAABCDEFGHIJKLMNOP',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123',
  bearer: `Bearer ${'d'.repeat(24)}`,
  cognee: `cognee_${'e'.repeat(24)}`,
}

describe('secret detection', () => {
  it.each([
    ['openai', samples.openai, 'api_key'],
    ['github', samples.github, 'github_token'],
    ['github_pat', samples.githubPat, 'github_token'],
    ['aws', samples.aws, 'aws_access_key'],
    ['jwt', samples.jwt, 'jwt'],
    ['bearer', samples.bearer, 'bearer_token'],
    ['cognee', samples.cognee, 'cognee_token'],
  ])('detects %s credentials', (_name, sample, kind) => {
    expect(findSecrets(`value: ${sample}`).map((finding) => finding.kind)).toContain(kind)
  })

  it('detects private key blocks', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----'
    expect(findSecrets(key)[0]?.kind).toBe('private_key')
  })

  it('detects password assignments and hides the value', () => {
    const findings = findSecrets('password = "correct-horse-battery"')
    expect(findings[0]?.kind).toBe('password_assignment')
    expect(redactSecrets('password = "correct-horse-battery"').text).not.toContain('correct-horse')
  })

  it('does not flag placeholders or documentation examples', () => {
    expect(findSecrets('api_key = process.env.API_KEY')).toHaveLength(0)
    expect(findSecrets('password: $PASSWORD')).toHaveLength(0)
    expect(findSecrets('token: <your-token-here>')).toHaveLength(0)
    expect(findSecrets('api_key = REDACTED')).toHaveLength(0)
  })

  it('reports and replaces every match with a kind marker', () => {
    const text = `first ${samples.openai} and second ${samples.aws}`
    const result = redactSecrets(text)
    expect(result.findings).toHaveLength(2)
    expect(result.text).toContain('[REDACTED:api_key]')
    expect(result.text).toContain('[REDACTED:aws_access_key]')
    expect(result.text).not.toContain(samples.openai)
    expect(result.text).not.toContain(samples.aws)
  })

  it('merges overlapping findings into one range', () => {
    const text = `api_key = ${samples.openai}`
    const findings = findSecrets(text)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.start).toBe(0)
  })

  it('leaves clean text unchanged', () => {
    expect(redactSecrets('The deploy target is blue.')).toEqual({
      text: 'The deploy target is blue.',
      findings: [],
      redacted: false,
    })
  })
})

describe('write-time guard', () => {
  it('rejects by default without echoing the secret', () => {
    try {
      guardForWrite(`key ${samples.openai}`, 'reject')
      throw new Error('expected rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(RedactionBlockedError)
      expect((error as RedactionBlockedError).code).toBe('REDACTION_BLOCKED')
      expect((error as Error).message).not.toContain(samples.openai)
      expect((error as RedactionBlockedError).kinds).toContain('api_key')
    }
  })

  it('redacts instead of rejecting in redact mode', () => {
    const result = guardForWrite(`token ${samples.openai}`, 'redact')
    expect(result.redacted).toBe(true)
    expect(result.text).not.toContain(samples.openai)
    expect(result.text).toContain('[REDACTED:api_key]')
  })
})
