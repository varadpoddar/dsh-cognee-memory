import { describe, expect, it } from 'vitest'
import {
  buildAuthHeaders,
  createEnvSecretResolver,
  redactHeaders,
  safeEndpoint,
} from '../src/security/secrets.js'
import { parseConfig } from '../src/config/schema.js'

describe('environment secrets', () => {
  it('resolves only non-empty environment values', () => {
    const resolver = createEnvSecretResolver({ TOKEN: '  value  ', EMPTY: '   ' })
    expect(resolver.has('TOKEN')).toBe(true)
    expect(resolver.require('TOKEN')).toBe('value')
    expect(resolver.has('EMPTY')).toBe(false)
  })

  it('fails closed with a message naming only the variable', () => {
    const resolver = createEnvSecretResolver({})
    expect(() => resolver.require('MISSING_TOKEN')).toThrowError(/MISSING_TOKEN/)
    expect(() => resolver.require('MISSING_TOKEN')).not.toThrowError(/sk-/)
  })

  it('rejects malformed environment variable names', () => {
    const resolver = createEnvSecretResolver({})
    expect(() => resolver.require('lower-case')).toThrow(/upper-case/)
  })
})

describe('auth headers', () => {
  it('adds nothing when auth is disabled', () => {
    expect(buildAuthHeaders({ authMode: 'none', apiTokenEnv: 'TOKEN' })).toEqual({})
  })

  it('uses bearer and api-key headers from the resolver', () => {
    const resolver = createEnvSecretResolver({ TOKEN: 'secret' })
    expect(buildAuthHeaders({ authMode: 'bearer', apiTokenEnv: 'TOKEN' }, resolver)).toEqual({
      Authorization: 'Bearer secret',
    })
    expect(buildAuthHeaders({ authMode: 'api-key', apiTokenEnv: 'TOKEN' }, resolver)).toEqual({
      'X-Api-Key': 'secret',
    })
  })

  it('redacts sensitive headers', () => {
    expect(redactHeaders({ Authorization: 'Bearer secret', 'X-Api-Key': 'secret', Accept: 'json' })).toEqual({
      Authorization: '[REDACTED]',
      'X-Api-Key': '[REDACTED]',
      Accept: 'json',
    })
  })

  it('strips userinfo, query, and hash from endpoints', () => {
    expect(safeEndpoint('http://user:pass@host:8000/api?token=secret#frag')).toBe('http://host:8000/api')
    expect(safeEndpoint('not a url')).toBe('<invalid-url>')
  })

  it('keeps only the environment variable name, never a token value', () => {
    const config = parseConfig({ authMode: 'bearer', apiTokenEnv: 'MY_TOKEN' })
    expect(config.apiTokenEnv).toBe('MY_TOKEN')
    expect(JSON.stringify(config)).not.toMatch(/Bearer |sk-/)
  })
})
