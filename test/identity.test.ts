import { describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config/schema.js'
import { IdentityResolver, PRINCIPAL_ENV } from '../src/memory/identity.js'
import { makeScopeRef, scopeKey, scopesForIdentity } from '../src/memory/scopes.js'

const base = {
  scopeDefaults: { projectId: 'e2e', teamId: 'platform' },
}

function resolver(options: {
  principal?: string
  probe?: string | undefined
  env?: NodeJS.ProcessEnv
  config?: Record<string, unknown>
} = {}) {
  const config = parseConfig({
    ...base,
    ...(options.principal === undefined ? {} : { identity: { principalId: options.principal } }),
    ...(options.config ?? {}),
  })
  return new IdentityResolver({
    config,
    env: options.env ?? {},
    cwd: '/workspace',
    adapter:
      options.probe === undefined
        ? {}
        : {
            async probePrincipal() {
              return options.probe
            },
          },
  })
}

describe('stable identity resolution', () => {
  it('uses the deployment principal before the environment and the probe', async () => {
    const r = resolver({
      principal: 'configured-user',
      probe: 'cognee-user',
      env: { [PRINCIPAL_ENV]: 'env-user' },
    })
    expect(await r.principalId()).toBe('configured-user')
  })

  it('uses the deployment environment before the authenticated probe', async () => {
    const r = resolver({ probe: 'cognee-user', env: { [PRINCIPAL_ENV]: 'env-user' } })
    expect(await r.principalId()).toBe('env-user')
  })

  it('falls back to the authenticated Cognee user id', async () => {
    const r = resolver({ probe: '05a6c959-3357-4a6d-a52a-1ad79ab16d8e' })
    expect(await r.principalId()).toBe('05a6c959-3357-4a6d-a52a-1ad79ab16d8e')
    const scopes = await r.scopes({ sessionId: 'session-a' })
    expect(scopes.map((scope) => scope.scope)).toEqual(['session', 'user', 'project', 'team'])
  })

  it('never derives a principal from a DSH session id', async () => {
    const r = resolver()
    expect(await r.principalId()).toBeUndefined()
    const scopes = await r.scopes({ sessionId: 'session-a' })
    expect(scopes.map((scope) => scope.scope)).toEqual(['session', 'project', 'team'])
    expect(scopes.filter((scope) => scope.scope !== 'session').map(scopeKey)).not.toContain(
      'dsh-session-session-a',
    )
  })

  it('survives a probe failure and retries only after the retry window', async () => {
    let now = 1_000
    let calls = 0
    const r = new IdentityResolver({
      config: parseConfig(base),
      env: {},
      adapter: {
        async probePrincipal() {
          calls += 1
          throw new Error('offline')
        },
      },
      now: () => now,
      probeRetryMs: 1_000,
    })
    expect(await r.principalId()).toBeUndefined()
    expect(await r.principalId()).toBeUndefined()
    expect(calls).toBe(1)
    now += 1_001
    await r.principalId()
    expect(calls).toBe(2)
  })

  it('produces session-independent namespaces across simulated processes', async () => {
    const first = resolver({ principal: 'p1', config: { scopes: { allowGlobal: true } } })
    const second = resolver({ principal: 'p1', config: { scopes: { allowGlobal: true } } })
    const a = await first.namespaces({ principalId: 'p1' })
    const b = await second.namespaces({ principalId: 'p1' })
    expect(a).toEqual(b)
    expect(a.user).toBe('dsh-user-p1')
    expect(a.project).toBe('dsh-project-e2e')
    expect(a.team).toBe('dsh-team-platform')
    expect(a.global).toBe('dsh-global')
    expect(JSON.stringify(a)).not.toMatch(/session-/)
  })

  it('separates principals, projects, teams, and agents without session ids', () => {
    const config = parseConfig({ ...base, scopes: { allowGlobal: false } })
    const one = scopesForIdentity(
      { sessionId: 'session-a', principalId: 'alice', agentPreset: 'worker', projectId: 'alpha' },
      config,
    )
    const two = scopesForIdentity(
      { sessionId: 'session-b', principalId: 'bob', agentPreset: 'worker', projectId: 'beta' },
      config,
    )
    const durable = (scopes: typeof one) =>
      scopes.filter((scope) => scope.scope !== 'session').map(scopeKey)
    expect(durable(one)).toEqual([
      'dsh-agent-worker',
      'dsh-user-alice',
      'dsh-project-alpha',
      'dsh-team-platform',
    ])
    expect(durable(two)).toContain('dsh-user-bob')
    expect(durable(one)).not.toContain('dsh-user-bob')
    expect(durable(one)).not.toContain('dsh-project-beta')
    expect(scopeKey(makeScopeRef('user', 'alice'))).toBe('dsh-user-alice')
  })

  it('omits global unless explicitly enabled', async () => {
    const off = resolver({ principal: 'p1' })
    expect((await off.namespaces()).global).toBeUndefined()
    const on = resolver({ principal: 'p1', config: { scopes: { allowGlobal: true } } })
    expect((await on.namespaces()).global).toBe('dsh-global')
  })

  it('keeps a readable deterministic project namespace from a path', () => {
    const ref = makeScopeRef('project', 'dsh/project/e2e')
    expect(scopeKey(ref)).toMatch(/^dsh-project-dsh-project-e2e-[0-9a-f]{20}$/)
    expect(scopeKey(makeScopeRef('project', 'dsh/project/e2e'))).toBe(scopeKey(ref))
  })
})
