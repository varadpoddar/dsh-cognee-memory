import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HttpJsonClient } from '../src/adapters/http-client.js'
import { parseConfig } from '../src/config/schema.js'
import { SettingsStore } from '../src/settings/store.js'
import { startMockServer } from './helpers/mock-server.js'

const AUTH = { COGNEE_API_KEY: 'test-key' }

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('changing the address retargets the adapter', () => {
  it('sends the next request to the newly saved endpoint', async () => {
    const first = await startMockServer(() => ({ status: 200, body: JSON.stringify({ data: [] }) }))
    const second = await startMockServer(() => ({ status: 200, body: JSON.stringify({ data: [] }) }))
    cleanups.push(() => first.close(), () => second.close())

    const directory = mkdtempSync(join(tmpdir(), 'cognee-retarget-'))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    const store = new SettingsStore({
      filePath: join(directory, 'settings.json'),
      baseConfig: parseConfig({ apiBaseUrl: `${first.url}/api/v1` }),
      env: {},
    })

    // The adapter is built once, exactly as `apply()` builds it; only the
    // settings store changes afterwards.
    const client = new HttpJsonClient({
      config: store.current(),
      env: AUTH,
      endpoint: () => store.current().apiBaseUrl,
    })

    await client.request({ method: 'GET', path: '/datasets', operation: 'status' })
    expect(first.requests).toHaveLength(1)
    expect(second.requests).toHaveLength(0)

    const saved = store.update({ apiBaseUrl: `${second.url}/api/v1`, enabled: true })
    expect(saved.ok).toBe(true)

    await client.request({ method: 'GET', path: '/datasets', operation: 'status' })
    expect(first.requests).toHaveLength(1)
    expect(second.requests).toHaveLength(1)
    // Same relative path as the first call, now resolved against the new base.
    expect(second.requests[0]?.url).toBe(first.requests[0]?.url)
  })

  it('keeps the previous target when a change is rejected', async () => {
    const first = await startMockServer(() => ({ status: 200, body: JSON.stringify({ data: [] }) }))
    cleanups.push(() => first.close())
    const directory = mkdtempSync(join(tmpdir(), 'cognee-retarget-'))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    const store = new SettingsStore({
      filePath: join(directory, 'settings.json'),
      baseConfig: parseConfig({ apiBaseUrl: `${first.url}/api/v1` }),
      env: {},
    })
    const client = new HttpJsonClient({
      config: store.current(),
      env: AUTH,
      endpoint: () => store.current().apiBaseUrl,
    })

    const rejected = store.update({ apiBaseUrl: 'http://user:pw@evil.local/api/v1', enabled: true })
    expect(rejected.ok).toBe(false)

    await client.request({ method: 'GET', path: '/datasets', operation: 'status' })
    expect(first.requests).toHaveLength(1)
  })
})
