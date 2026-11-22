import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config/schema.js'
import { SettingsStore } from '../src/settings/store.js'
import { registerSettingsRoutes, renderSettingsPage, SETTINGS_JSON_PATH, SETTINGS_PAGE_PATH } from '../src/settings/http.js'
import type { WebRouteLike, WebServerLike } from '../src/types.js'

const temporary: string[] = []
const TOKEN = 'settings-token-abc'
const SECRET = 'sk-cognee-live-should-never-render'

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

interface Captured {
  status: number
  headers: Record<string, string | number | string[] | undefined>
  body: string
}

function makeRequest(method: string, url: string, headers: Record<string, string>, body?: string): IncomingMessage {
  const request = new Readable({ read() {} }) as IncomingMessage & Readable
  request.method = method
  request.url = url
  request.headers = headers
  request.push(body ?? null)
  request.push(null)
  return request
}

/** Minimal ServerResponse that resolves once the handler writes the response. */
function makeResponse(): { response: ServerResponse; done: Promise<Captured> } {
  let resolve!: (value: Captured) => void
  const done = new Promise<Captured>((r) => {
    resolve = r
  })
  const captured: Captured = { status: 200, headers: {}, body: '' }
  const response = {
    setHeader(name: string, value: string | number | string[]) {
      captured.headers[name.toLowerCase()] = value
      return this
    },
    writeHead(status: number, headers?: Record<string, string | number | string[]>) {
      captured.status = status
      for (const [name, value] of Object.entries(headers ?? {})) captured.headers[name.toLowerCase()] = value
      return this
    },
    end(chunk?: string) {
      captured.body += chunk ?? ''
      resolve(captured)
      return this
    },
  } as unknown as ServerResponse
  return { response, done }
}

function harness(options: { env?: NodeJS.ProcessEnv; file?: string } = {}) {
  const file = options.file ?? join(mkdtempSync(join(tmpdir(), 'cognee-http-')), 'settings.json')
  if (options.file === undefined) temporary.push(file.replace(/\/settings\.json$/, ''))
  const store = new SettingsStore({
    filePath: file,
    baseConfig: parseConfig({ apiBaseUrl: 'http://profile.local:8000/api/v1' }),
    env: options.env ?? {},
  })
  const routes = new Map<string, WebRouteLike>()
  const webServer: WebServerLike = {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const disposers = registerSettingsRoutes(webServer, { store, env: options.env ?? {} })
  return {
    store,
    file,
    routes,
    disposers,
    async request(path: string, method: string, headers: Record<string, string> = {}, body?: string) {
      const route = routes.get(path.startsWith(SETTINGS_JSON_PATH) ? SETTINGS_JSON_PATH : SETTINGS_PAGE_PATH)
      if (route === undefined) throw new Error(`route not registered: ${path}`)
      const { response, done } = makeResponse()
      await route.handler(makeRequest(method, path, headers, body), response)
      return done
    },
  }
}

const form = { 'content-type': 'application/x-www-form-urlencoded' }

describe('settings routes require an operator token', () => {
  it('answers 503 and names the variable when no token is configured', async () => {
    const h = harness({ env: {} })
    const response = await h.request(SETTINGS_PAGE_PATH, 'GET')
    expect(response.status).toBe(503)
    expect(response.body).toContain('COGNEE_MEMORY_SETTINGS_TOKEN')
  })

  it('answers 401 without, or with a wrong, token', async () => {
    const env = { COGNEE_MEMORY_SETTINGS_TOKEN: TOKEN }
    const h = harness({ env })

    const anonymous = await h.request(SETTINGS_PAGE_PATH, 'GET')
    expect(anonymous.status).toBe(401)

    const wrong = await h.request(SETTINGS_PAGE_PATH, 'POST', { ...form, authorization: 'Bearer nope' }, 'apiBaseUrl=http://evil.local/api/v1')
    expect(wrong.status).toBe(401)
    expect(() => readFileSync(h.file, 'utf8')).toThrow()
  })

  it('accepts the query token and the bearer header', async () => {
    const env = { COGNEE_MEMORY_SETTINGS_TOKEN: TOKEN }
    const h = harness({ env })
    expect((await h.request(`${SETTINGS_PAGE_PATH}?token=${TOKEN}`, 'GET')).status).toBe(200)
    expect((await h.request(SETTINGS_PAGE_PATH, 'GET', { authorization: `Bearer ${TOKEN}` })).status).toBe(200)
  })
})

describe('settings page', () => {
  it('renders the active endpoint and reports the key only as set/unset', async () => {
    const env = { COGNEE_MEMORY_SETTINGS_TOKEN: TOKEN, COGNEE_API_KEY: SECRET }
    const h = harness({ env })
    const response = await h.request(`${SETTINGS_PAGE_PATH}?token=${TOKEN}`, 'GET')
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.body).toContain('http://profile.local:8000/api/v1')
    expect(response.body).toContain('COGNEE_API_KEY')
    expect(response.body).toContain('<dd>set</dd>')
    expect(response.body).not.toContain(SECRET)
    expect(response.body).not.toContain(TOKEN)
  })

  it('never renders the key even when it is unset', () => {
    const store = new SettingsStore({
      filePath: join(mkdtempSync(join(tmpdir(), 'cognee-page-')), 'settings.json'),
      baseConfig: parseConfig({ apiBaseUrl: 'http://profile.local:8000/api/v1' }),
      env: {},
    })
    const html = renderSettingsPage(store.status())
    expect(html).toContain('<dd>unset</dd>')
    expect(html).not.toContain(SECRET)
  })

  it('escapes validation errors instead of reflecting markup', async () => {
    const env = { COGNEE_MEMORY_SETTINGS_TOKEN: TOKEN }
    const h = harness({ env })
    const body = new URLSearchParams({ apiBaseUrl: '<script>alert(1)</script>', mcpUrl: '', enabled: 'on' }).toString()
    const response = await h.request(`${SETTINGS_PAGE_PATH}?token=${TOKEN}`, 'POST', form, body)
    expect(response.status).toBe(400)
    expect(response.body).not.toContain('<script>alert(1)</script>')
    expect(response.body).toContain('absolute http(s)')
    expect(() => readFileSync(h.file, 'utf8')).toThrow()
  })

  it('escapes whatever it is asked to render', () => {
    const store = new SettingsStore({
      filePath: join(mkdtempSync(join(tmpdir(), 'cognee-page-')), 'settings.json'),
      baseConfig: parseConfig({ apiBaseUrl: 'http://profile.local:8000/api/v1' }),
      env: {},
    })
    const html = renderSettingsPage(store.status(), {
      errors: ['apiBaseUrl: <img src=x onerror=alert(1)>'],
      notice: '<b>done</b>',
    })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&lt;b&gt;done&lt;/b&gt;')
  })
})

describe('saving the address', () => {
  it('persists a valid change, redirects, and applies it to later reads', async () => {
    const env = { COGNEE_MEMORY_SETTINGS_TOKEN: TOKEN }
    const h = harness({ env })
    const body = new URLSearchParams({
      apiBaseUrl: 'http://10.20.10.15:8000/api/v1',
      mcpUrl: '',
      enabled: 'on',
    }).toString()
    const response = await h.request(`${SETTINGS_PAGE_PATH}?token=${TOKEN}`, 'POST', form, body)
    expect(response.status).toBe(303)
    expect(String(response.headers.location)).toContain(SETTINGS_PAGE_PATH)

    expect(h.store.current().apiBaseUrl).toBe('http://10.20.10.15:8000/api/v1')
    const persisted = JSON.parse(readFileSync(h.file, 'utf8')) as { apiBaseUrl: string }
    expect(persisted.apiBaseUrl).toBe('http://10.20.10.15:8000/api/v1')

    const page = await h.request(`${SETTINGS_PAGE_PATH}?token=${TOKEN}`, 'GET')
    expect(page.body).toContain('http://10.20.10.15:8000/api/v1')
    expect(page.body).toContain('Source: stored')
  })

  it('exposes the active endpoint as JSON without credentials', async () => {
    const env = { COGNEE_MEMORY_SETTINGS_TOKEN: TOKEN, COGNEE_API_KEY: SECRET }
    const h = harness({ env })
    const response = await h.request(`${SETTINGS_JSON_PATH}?token=${TOKEN}`, 'GET')
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')
    const parsed = JSON.parse(response.body) as {
      endpoint: string
      credential: { variable: string; state: string }
    }
    expect(parsed.endpoint).toBe('http://profile.local:8000/api/v1')
    expect(parsed.credential).toEqual({ variable: 'COGNEE_API_KEY', state: 'set' })
    expect(response.body).not.toContain(SECRET)
  })

  it('rejects a non-form content type', async () => {
    const env = { COGNEE_MEMORY_SETTINGS_TOKEN: TOKEN }
    const h = harness({ env })
    const response = await h.request(
      `${SETTINGS_PAGE_PATH}?token=${TOKEN}`,
      'POST',
      { 'content-type': 'application/json' },
      JSON.stringify({ apiBaseUrl: 'http://x.local/api/v1' }),
    )
    expect(response.status).toBe(415)
  })
})
