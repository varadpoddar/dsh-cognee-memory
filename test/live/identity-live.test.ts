import { describe, expect, it } from 'vitest'
import { createMemoryAdapter } from '../../src/adapters/memory-adapter.js'
import { parseConfig } from '../../src/config/schema.js'
import { IdentityResolver } from '../../src/memory/identity.js'
import { scopeKey } from '../../src/memory/scopes.js'
import { Metrics } from '../../src/telemetry/metrics.js'

/** Read-only live proof that the authenticated Cognee user drives stable namespaces. */
const apiKey = process.env.COGNEE_API_KEY?.trim()
const baseUrl = (process.env.COGNEE_BASE_URL ?? 'http://10.20.10.15:8000/api/v1').replace(/\/+$/, '')

describe.skipIf(apiKey === undefined || apiKey === '')('stable identity (live Cognee)', () => {
  it('uses the authenticated user id and never a DSH session id', async () => {
    const config = parseConfig({
      transport: 'rest',
      apiBaseUrl: baseUrl,
      authMode: 'api-key',
      apiTokenEnv: 'COGNEE_API_KEY',
      scopeDefaults: { projectId: 'dsh/project/e2e', teamId: 'platform' },
      scopes: { allowGlobal: false },
    })
    const metrics = new Metrics()
    const adapter = createMemoryAdapter({ config, metrics, env: process.env, endpoint: () => baseUrl })
    const resolver = new IdentityResolver({ config, env: {}, adapter })
    const principal = await resolver.principalId()
    expect(principal).toMatch(/^[0-9a-f-]{36}$/i)

    const a = await resolver.namespaces({ sessionId: 'session-A' })
    const b = await resolver.namespaces({ sessionId: 'session-B' })
    expect(a).toEqual(b)
    expect(a.user).toBe(`dsh-user-${principal}`)
    expect(a.project).toMatch(/^dsh-project-dsh-project-e2e-[0-9a-f]{20}$/)
    expect(a.team).toBe('dsh-team-platform')
    expect(a.global).toBeUndefined()
    expect(JSON.stringify(a)).not.toMatch(/session-(A|B)/)
    expect(a.user).not.toBe(scopeKey({ scope: 'session', id: 'session-A' }))
  }, 30_000)

  it('does not create or read another principal namespace through a prompt-like scope name', async () => {
    const config = parseConfig({
      transport: 'rest',
      apiBaseUrl: baseUrl,
      authMode: 'api-key',
      apiTokenEnv: 'COGNEE_API_KEY',
      scopeDefaults: { projectId: 'dsh/project/e2e' },
    })
    const metrics = new Metrics()
    const adapter = createMemoryAdapter({ config, metrics, env: process.env, endpoint: () => baseUrl })
    const resolver = new IdentityResolver({ config, env: {}, adapter })
    const namespaces = await resolver.namespaces({ principalId: 'attacker-chosen' })
    expect(namespaces.user).toBe('dsh-user-attacker-chosen')
    const real = await resolver.namespaces()
    expect(real.user).not.toBe(namespaces.user)
  }, 30_000)
})
