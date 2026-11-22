import { describe, expect, it } from 'vitest'
import { validateCogneeUrl } from '../src/settings/url.js'

describe('runtime Cognee URL validation', () => {
  it('accepts http and https and normalizes a trailing slash', () => {
    expect(validateCogneeUrl('http://10.20.10.15:8000/api/v1')).toEqual({
      ok: true,
      url: 'http://10.20.10.15:8000/api/v1',
    })
    expect(validateCogneeUrl('  https://cognee.internal/api/v1/  ')).toEqual({
      ok: true,
      url: 'https://cognee.internal/api/v1',
    })
    expect(validateCogneeUrl('http://cognee.internal')).toEqual({ ok: true, url: 'http://cognee.internal' })
  })

  it.each([
    ['', 'must not be empty'],
    ['   ', 'must not be empty'],
    ['cognee.internal:8000', 'absolute http(s)'],
    ['ftp://cognee.internal/api/v1', 'absolute http(s)'],
    ['file:///etc/passwd', 'absolute http(s)'],
    ['http://user:secret@cognee.internal/api/v1', 'credentials'],
    ['http://cognee.internal/api/v1?token=abc', 'query string'],
    ['http://cognee.internal/api/v1#frag', 'fragment'],
  ])('rejects %j', (input, message) => {
    const result = validateCogneeUrl(input)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain(message)
  })

  it('rejects non-strings and over-long URLs', () => {
    expect(validateCogneeUrl(undefined).ok).toBe(false)
    expect(validateCogneeUrl(42).ok).toBe(false)
    expect(validateCogneeUrl(`http://h/${'a'.repeat(2_100)}`).ok).toBe(false)
  })
})
