import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config/schema.js'
import {
  formatScope,
  globalScope,
  identityFromAgent,
  isMemoryScope,
  makeScopeRef,
  normalizeRawScopeId,
  sameScope,
  scopeFromName,
  scopeIdFor,
  scopeKey,
  scopesForIdentity,
} from '../src/memory/scopes.js'

const config = parseConfig({
  scopeDefaults: { projectId: '/workspace/demo', teamId: 'team-a' },
  scopes: { allowGlobal: true },
})

describe('stable scope ids', () => {
  it('derives a deterministic opaque id without the raw value', () => {
    const first = makeScopeRef('session', 'session-abc')
    const second = makeScopeRef('session', 'session-abc')
    expect(first).toEqual(second)
    expect(first.id).toBe('session-abc')
    expect(scopeKey(first)).toBe('dsh-session-session-abc')
  })

  it('separates the same raw id in different scopes', () => {
    expect(scopeKey(makeScopeRef('session', 'same'))).not.toBe(
      scopeKey(makeScopeRef('agent', 'same')),
    )
  })

  it('keeps global as one singleton scope', () => {
    expect(globalScope()).toEqual({ scope: 'global', id: 'global' })
    expect(scopeIdFor('global', 'anything')).toBe('global')
  })

  it('normalizes whitespace but treats different ids differently', () => {
    expect(scopeIdFor('project', '  /a  b ')).toBe(scopeIdFor('project', '/a b'))
    expect(scopeIdFor('project', '/a')).not.toBe(scopeIdFor('project', '/b'))
  })

  it('rejects empty, control-character, and oversized raw ids', () => {
    expect(() => normalizeRawScopeId('   ')).toThrow(/empty/)
    expect(() => normalizeRawScopeId('a\u0000b')).toThrow(/control/)
    expect(() => normalizeRawScopeId('a'.repeat(600))).toThrow(/exceeds/)
  })

  it('validates scope names and compares refs', () => {
    expect(isMemoryScope('project')).toBe(true)
    expect(isMemoryScope('tenant')).toBe(false)
    const scope = makeScopeRef('team', 'team-a')
    expect(sameScope(scope, { ...scope })).toBe(true)
    expect(sameScope(scope, globalScope())).toBe(false)
    expect(formatScope(scope)).toBe(`team:${scope.id}`)
  })
})

describe('caller identity scopes', () => {
  it('includes session, agent, project, team, and global in order', () => {
    const scopes = scopesForIdentity(
      { sessionId: 's1', principalId: 'p1', agentId: 'a1', projectId: '/project', teamId: 'team' },
      config,
    )
    expect(scopes.map((scope) => scope.scope)).toEqual([
      'session',
      'agent',
      'user',
      'project',
      'team',
      'global',
    ])
  })

  it('omits session when no session id exists', () => {
    const scopes = scopesForIdentity({ projectId: '/project' }, config)
    expect(scopes.map((scope) => scope.scope)).not.toContain('session')
    expect(scopes.map((scope) => scope.scope)).not.toContain('agent')
  })

  it('prefers config project/team defaults and falls back to cwd', () => {
    expect(scopesForIdentity({}, config).map((scope) => scope.id)).toContain(makeScopeRef('project', '/workspace/demo').id)
    expect(scopesForIdentity({}, config).map((scope) => scope.id)).toContain(makeScopeRef('team', 'team-a').id)
    expect(scopesForIdentity({}, parseConfig({}), '/tmp/ws').map((scope) => scope.id)).toContain(
      makeScopeRef('project', '/tmp/ws').id,
    )
  })

  it('extracts a structural agent session id', () => {
    expect(identityFromAgent({ session: { id: 's1' } })).toEqual({ sessionId: 's1' })
    expect(
      identityFromAgent({ session: { id: 's1', header: { agentPreset: 'worker' } } }),
    ).toEqual({ sessionId: 's1', agentPreset: 'worker' })
    expect(identityFromAgent({})).toEqual({})
    expect(identityFromAgent(undefined)).toEqual({})
  })

  it('resolves model-supplied scope names only within caller scopes', () => {
    const identity = { sessionId: 's1', principalId: 'p1' }
    expect(scopeFromName('session', identity, config)).toEqual(makeScopeRef('session', 's1'))
    expect(scopeFromName('user', identity, config)).toEqual(makeScopeRef('user', 'p1'))
    expect(scopeFromName('global', identity, config)).toEqual(globalScope())
    expect(() => scopeFromName('global', identity, parseConfig({}))).toThrow(/not enabled/)
    expect(() => scopeFromName('tenant', identity, config)).toThrow(/scope must be one of/)
    expect(() => scopeFromName('team', { sessionId: 's1' }, parseConfig({}))).toThrow(/FORBIDDEN|no team/)
  })
})
