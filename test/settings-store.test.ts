import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config/schema.js'
import { SettingsStore, resolveSettingsPath } from '../src/settings/store.js'

const temporary: string[] = []

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'cognee-settings-'))
  temporary.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const PROFILE_URL = 'http://profile.local:8000/api/v1'
const ENV_URL = 'http://env.local:8000/api/v1'
const STORED_URL = 'http://stored.local:8000/api/v1'

function store(options: { file?: string; env?: NodeJS.ProcessEnv; base?: unknown } = {}): SettingsStore {
  return new SettingsStore({
    filePath: options.file ?? join(scratch(), 'settings.json'),
    baseConfig: parseConfig(options.base ?? { apiBaseUrl: PROFILE_URL }),
    env: options.env ?? {},
  })
}

describe('settings precedence', () => {
  it('falls back to the profile entry when nothing else is set', () => {
    const settings = store()
    expect(settings.current().apiBaseUrl).toBe(PROFILE_URL)
    expect(settings.status().sources.apiBaseUrl).toBe('profile')
  })

  it('lets the environment outrank the profile entry', () => {
    const settings = store({ env: { COGNEE_MEMORY_API_BASE_URL: ENV_URL } })
    expect(settings.current().apiBaseUrl).toBe(ENV_URL)
    expect(settings.status().sources.apiBaseUrl).toBe('env')
  })

  it('lets a stored setting outrank the environment', () => {
    const directory = scratch()
    const file = join(directory, 'settings.json')
    writeFileSync(file, JSON.stringify({ version: 1, apiBaseUrl: STORED_URL, enabled: true }))
    const settings = store({ file, env: { COGNEE_MEMORY_API_BASE_URL: ENV_URL } })
    expect(settings.current().apiBaseUrl).toBe(STORED_URL)
    expect(settings.status().sources.apiBaseUrl).toBe('stored')
  })

  it('records a deliberate MCP clear so it outranks the environment', () => {
    const file = join(scratch(), 'settings.json')
    writeFileSync(
      file,
      JSON.stringify({ version: 1, apiBaseUrl: STORED_URL, mcpUrl: null, enabled: true }),
    )
    const settings = store({ file, env: { COGNEE_MEMORY_MCP_URL: 'http://env.local/mcp' } })
    expect(settings.current().mcpUrl).toBeUndefined()
    expect(settings.status().sources.mcpUrl).toBe('stored')
  })

  it('reports the key as set/unset from the environment only', () => {
    expect(store({ env: { COGNEE_API_KEY: 'sk-live-secret' } }).status()).toMatchObject({
      keyVar: 'COGNEE_API_KEY',
      keySet: true,
    })
    expect(store({ env: {} }).status()).toMatchObject({ keyVar: 'COGNEE_API_KEY', keySet: false })
  })
})

describe('settings persistence', () => {
  it('persists a validated change without the Cognee key and applies it immediately', () => {
    const file = join(scratch(), 'nested', 'settings.json')
    const settings = store({ file, env: { COGNEE_API_KEY: 'sk-live-secret' } })

    const result = settings.update({ apiBaseUrl: STORED_URL, mcpUrl: '', enabled: true })
    expect(result.ok).toBe(true)
    expect(settings.current().apiBaseUrl).toBe(STORED_URL)

    const raw = readFileSync(file, 'utf8')
    expect(JSON.parse(raw)).toMatchObject({ version: 1, apiBaseUrl: STORED_URL, mcpUrl: null })
    expect(raw).not.toContain('sk-live-secret')
    expect(raw).not.toContain('COGNEE_API_KEY')
  })

  it('rejects a junk URL and writes nothing', () => {
    const file = join(scratch(), 'settings.json')
    const settings = store({ file })
    const result = settings.update({ apiBaseUrl: 'javascript:alert(1)', enabled: true })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(' ')).toContain('apiBaseUrl')
    expect(settings.current().apiBaseUrl).toBe(PROFILE_URL)
    expect(() => readFileSync(file, 'utf8')).toThrow()
  })

  it('picks up a hand edit on the next read without a restart', () => {
    const file = join(scratch(), 'settings.json')
    const settings = store({ file })
    expect(settings.current().apiBaseUrl).toBe(PROFILE_URL)
    writeFileSync(file, JSON.stringify({ version: 1, apiBaseUrl: STORED_URL, enabled: true }))
    expect(settings.current().apiBaseUrl).toBe(STORED_URL)
  })

  it('keeps the last good value and warns when the file is invalid', () => {
    const file = join(scratch(), 'settings.json')
    writeFileSync(file, JSON.stringify({ version: 1, apiBaseUrl: STORED_URL, enabled: true }))
    const settings = store({ file })
    expect(settings.current().apiBaseUrl).toBe(STORED_URL)
    writeFileSync(file, JSON.stringify({ version: 1, apiBaseUrl: 'not-a-url', enabled: true }))
    expect(settings.current().apiBaseUrl).toBe(STORED_URL)
    expect(settings.status().warnings.join(' ')).toContain('apiBaseUrl')
  })

  it('notifies subscribers when the effective endpoint changes', () => {
    const settings = store()
    const seen: string[] = []
    const unsubscribe = settings.onChange((config) => seen.push(config.apiBaseUrl))
    settings.update({ apiBaseUrl: STORED_URL, enabled: true })
    unsubscribe()
    settings.update({ apiBaseUrl: ENV_URL, enabled: true })
    expect(seen).toEqual([STORED_URL])
  })
})

describe('settings file location', () => {
  it('honours the explicit override, then DSH_HOME, then ~/.dsh', () => {
    expect(resolveSettingsPath({ COGNEE_MEMORY_SETTINGS_FILE: '/tmp/custom.json' })).toBe('/tmp/custom.json')
    expect(resolveSettingsPath({ DSH_HOME: '/srv/dsh' })).toBe('/srv/dsh/plugins/cognee-memory/settings.json')
    expect(resolveSettingsPath({})).toMatch(/\/\.dsh\/plugins\/cognee-memory\/settings\.json$/)
  })
})
