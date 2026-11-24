import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config/schema.js'
import { SettingsStore } from '../src/settings/store.js'
import {
  COGNEE_UI_BASE_URL_ENV,
  DEFAULT_COGNEE_UI_BASE_URL,
  MEMORIES_JSON_PATH,
  PROVENANCE_PATH_PREFIX,
  deepLinkFor,
  registerProvenanceRoutes,
} from '../src/settings/provenance-http.js'
import { ProvenanceIndex, type ProvenanceAccess } from '../src/memory/provenance-index.js'
import type { RecallHit, ScopeRef, WebRouteLike, WebServerLike } from '../src/types.js'

const temporary: string[] = []
const TOKEN = 'provenance-token-abc'
const SECRET = 'sk-cognee-live-should-never-render'
const PROJECT: ScopeRef = { scope: 'project', id: 'demo-project' }
const OTHER_PROJECT: ScopeRef = { scope: 'project', id: 'other-project' }

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

interface Captured {
  status: number
  headers: Record<string, string | number | string[] | undefined>
  body: string
}

function makeRequest(method: string, url: string, headers: Record<string, string>): IncomingMessage {
  const request = new Readable({ read() {} }) as IncomingMessage & Readable
  request.method = method
  request.url = url
  request.headers = headers
  request.push(null)
  return request
}

function makeResponse(): { response: ServerResponse; done: Promise<Captured> } {
  let resolve!: (value: Captured) => void
  const done = new Promise<Captured>((r) => {
    resolve = r
  })
  const captured: Captured = { status: 200, headers: {}, body: '' }
  const response = {
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

function hit(id: string, text: string, scope: ScopeRef = PROJECT): RecallHit {
  return { record: { id, text, scope, createdAt: '2026-01-02T03:04:05.000Z' }, score: 0.9 }
}

interface HarnessOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly access?: ProvenanceAccess
  readonly accessThrows?: boolean
  readonly datasetId?: string
  readonly cogneeUiBaseUrl?: string
  readonly resolveDatasetId?: (datasetName: string) => Promise<string | undefined>
}

function harness(options: HarnessOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'cognee-provenance-http-'))
  temporary.push(directory)
  const env = options.env ?? {}
  const store = new SettingsStore({
    filePath: join(directory, 'settings.json'),
    baseConfig: parseConfig({ apiBaseUrl: 'http://profile.local:8000/api/v1' }),
    env,
  })
  const index = new ProvenanceIndex({ filePath: join(directory, 'provenance.json') })
  index.recordRecall([hit('mem-1', 'Release codename: amber-otter-7731'), hit('mem-2', '<script>alert(1)</script><img src=x onerror=alert(2)>')], {
    identity: { principalId: 'operator' },
    searchType: 'GRAPH_COMPLETION',
    ...(options.datasetId === undefined ? {} : { datasetIds: { 'dsh-project-demo-project': options.datasetId } }),
  })
  index.recordRecall([hit('mem-hidden', 'other project secret', OTHER_PROJECT)], {
    identity: { principalId: 'operator' },
  })
  index.recordRecall([hit('mem-foreign', 'someone else secret')], { identity: { principalId: 'other-user' } })

  const access = options.access ?? { principalId: 'operator', readableScopes: [PROJECT] }
  const routes: WebRouteLike[] = []
  const webServer: WebServerLike = {
    register(route) {
      routes.push(route)
      return () => {
        const at = routes.indexOf(route)
        if (at >= 0) routes.splice(at, 1)
      }
    },
  }
  const disposers = registerProvenanceRoutes(webServer, {
    index,
    store,
    env,
    access: async () => {
      if (options.accessThrows === true) throw new Error('identity unavailable')
      return access
    },
    ...(options.cogneeUiBaseUrl === undefined ? {} : { cogneeUiBaseUrl: options.cogneeUiBaseUrl }),
    ...(options.resolveDatasetId === undefined
      ? {}
      : { resolveDatasetId: options.resolveDatasetId, resolutionTimeoutMs: 100 }),
  })
  return {
    index,
    routes,
    disposers,
    async request(path: string, method = 'GET', headers: Record<string, string> = {}) {
      const target = new URL(path, 'http://localhost')
      const route = routes.find((candidate) =>
        candidate.kind === 'prefix'
          ? target.pathname.startsWith(candidate.path)
          : target.pathname === candidate.path,
      )
      if (route === undefined) throw new Error(`route not registered: ${path}`)
      const { response, done } = makeResponse()
      await route.handler(makeRequest(method, path, headers), response)
      return done
    },
  }
}

const authorized = { authorization: `Bearer ${TOKEN}` }
const memoryPath = (id: string): string => `${PROVENANCE_PATH_PREFIX}${encodeURIComponent(id)}`
const env = { COGNEE_MEMORY_SETTINGS_TOKEN: TOKEN, COGNEE_API_KEY: SECRET }

describe('provenance route shape', () => {
  it('registers a route path with no trailing slash, matching p and p/<id>', () => {
    const h = harness({ env })
    const prefix = h.routes.find((route) => route.kind === 'prefix')
    expect(prefix?.path).toBe('/plugins/cognee-memory/memory')
    expect(prefix?.path.endsWith('/')).toBe(false)
    expect(PROVENANCE_PATH_PREFIX.endsWith('/')).toBe(true)
  })
})

describe('provenance JSON route', () => {
  it('serves provenance for an authorized memory id', async () => {
    const h = harness({ env, datasetId: '11111111-2222-3333-4444-555555555555' })
    const response = await h.request(`${PROVENANCE_PATH_PREFIX}mem-1`, 'GET', authorized)
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    const body = JSON.parse(response.body) as Record<string, unknown>
    expect(body.id).toBe('mem-1')
    expect(body.dataset).toEqual({
      name: 'dsh-project-demo-project',
      id: '11111111-2222-3333-4444-555555555555',
    })
    expect(body.scope).toEqual({ scope: 'project', id: 'demo-project' })
    expect(body.createdAt).toBe('2026-01-02T03:04:05.000Z')
    expect(body.ingest).toEqual({ state: 'indexed' })
    expect(body.surfaced).toMatchObject({ searchType: 'GRAPH_COMPLETION', confidence: 'high' })
    expect(body.deepLink).toBe(
      `${DEFAULT_COGNEE_UI_BASE_URL}/datasets/11111111-2222-3333-4444-555555555555`,
    )
    expect(body.excerpt).toContain('amber-otter-7731')
    expect(response.body).not.toContain(TOKEN)
    expect(response.body).not.toContain(SECRET)
  })

  it('resolves the dataset UUID lazily and persists it', async () => {
    const h = harness({
      env,
      resolveDatasetId: async (name) =>
        name === 'dsh-project-demo-project' ? 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' : undefined,
    })
    const response = await h.request(`${PROVENANCE_PATH_PREFIX}mem-1`, 'GET', authorized)
    expect(response.status).toBe(200)
    expect((JSON.parse(response.body) as { dataset: { id: string } }).dataset.id).toBe(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    )
    expect(h.index.get('mem-1', { principalId: 'operator', readableScopes: [PROJECT] })?.dataset.id).toBe(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    )
  })

  it('degrades to the UI origin when dataset resolution fails or times out', async () => {
    const h = harness({
      env,
      resolveDatasetId: async () => {
        throw new Error('inventory unavailable')
      },
    })
    const response = await h.request(`${PROVENANCE_PATH_PREFIX}mem-1`, 'GET', authorized)
    expect(response.status).toBe(200)
    expect((JSON.parse(response.body) as { deepLink: string }).deepLink).toBe(DEFAULT_COGNEE_UI_BASE_URL)
  })

  it('falls back to the Cognee UI origin when the dataset UUID is unknown', async () => {
    const h = harness({ env })
    const response = await h.request(`${PROVENANCE_PATH_PREFIX}mem-1?token=${TOKEN}`)
    expect(response.status).toBe(200)
    expect((JSON.parse(response.body) as { deepLink: string }).deepLink).toBe(DEFAULT_COGNEE_UI_BASE_URL)
  })

  it('honours COGNEE_UI_BASE_URL and an explicit base URL', async () => {
    const h = harness({ env: { ...env, [COGNEE_UI_BASE_URL_ENV]: 'http://cognee.example:3000/' } })
    const response = await h.request(`${PROVENANCE_PATH_PREFIX}mem-1`, 'GET', authorized)
    expect((JSON.parse(response.body) as { deepLink: string }).deepLink).toBe('http://cognee.example:3000')
    expect(deepLinkFor({ id: 'a b' }, 'http://cognee.example')).toBe('http://cognee.example/datasets/a%20b')
  })

  it('answers 503 without a settings token and 401 for a missing or wrong token', async () => {
    const unset = harness({ env: {} })
    const disabled = await unset.request(`${PROVENANCE_PATH_PREFIX}mem-1`)
    expect(disabled.status).toBe(503)
    expect(disabled.body).not.toContain('amber-otter-7731')

    const h = harness({ env })
    expect((await h.request(`${PROVENANCE_PATH_PREFIX}mem-1`)).status).toBe(401)
    expect((await h.request(`${PROVENANCE_PATH_PREFIX}mem-1`, 'GET', { authorization: 'Bearer nope' })).status).toBe(401)
    expect((await h.request(MEMORIES_JSON_PATH)).status).toBe(401)
  })

  it('answers a generic 404 for unknown, cross-scope, and foreign-principal ids', async () => {
    const h = harness({ env })
    const unknown = await h.request(`${PROVENANCE_PATH_PREFIX}mem-nope`, 'GET', authorized)
    const crossScope = await h.request(`${PROVENANCE_PATH_PREFIX}mem-hidden`, 'GET', authorized)
    const foreign = await h.request(`${PROVENANCE_PATH_PREFIX}mem-foreign`, 'GET', authorized)
    expect(unknown.status).toBe(404)
    expect(crossScope.status).toBe(404)
    expect(foreign.status).toBe(404)
    // Identical body: the route must not reveal that an id exists elsewhere.
    expect(crossScope.body).toBe(unknown.body)
    expect(foreign.body).toBe(unknown.body)
    expect(crossScope.body).not.toContain('other project secret')
    expect(foreign.body).not.toContain('someone else secret')
    expect(crossScope.body).not.toContain('mem-hidden')
  })

  it('answers 404 when the access resolver cannot establish a caller', async () => {
    const h = harness({ env, accessThrows: true })
    expect((await h.request(`${PROVENANCE_PATH_PREFIX}mem-1`, 'GET', authorized)).status).toBe(404)
  })

  it('rejects malformed and traversing ids with 404', async () => {
    const h = harness({ env })
    expect((await h.request(`${PROVENANCE_PATH_PREFIX}%2e%2e%2fetc%2fpasswd`, 'GET', authorized)).status).toBe(404)
    expect((await h.request(`${PROVENANCE_PATH_PREFIX}mem-1%2fextra`, 'GET', authorized)).status).toBe(404)
  })

  it('only allows GET and HEAD', async () => {
    const h = harness({ env })
    const response = await h.request(`${PROVENANCE_PATH_PREFIX}mem-1`, 'POST', authorized)
    expect(response.status).toBe(405)
    expect(response.headers.allow).toContain('GET')
  })
})

describe('provenance detail page', () => {
  it('renders every field, the deep link, and the security headers', async () => {
    const h = harness({ env, datasetId: '11111111-2222-3333-4444-555555555555' })
    const response = await h.request(`${PROVENANCE_PATH_PREFIX}mem-1?token=${TOKEN}&format=html`)
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['content-security-policy']).toContain("default-src 'none'")
    expect(response.headers['content-security-policy']).not.toContain('script-src')
    expect(response.body).toContain('Memory provenance')
    expect(response.body).toContain('dsh-project-demo-project')
    expect(response.body).toContain('11111111-2222-3333-4444-555555555555')
    expect(response.body).toContain('GRAPH_COMPLETION')
    expect(response.body).toContain(`${DEFAULT_COGNEE_UI_BASE_URL}/datasets/11111111-2222-3333-4444-555555555555`)
    expect(response.body).toContain('amber-otter-7731')
    expect(response.body).not.toContain(TOKEN)
    expect(response.body).not.toContain(SECRET)
  })

  it('serves the panel with ?format=page as CSP-safe HTML', async () => {
    const h = harness({ env, datasetId: '11111111-2222-3333-4444-555555555555' })
    const response = await h.request(`${PROVENANCE_PATH_PREFIX}mem-1?token=${TOKEN}&format=page`)
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.headers['content-security-policy']).toContain("default-src 'none'")
    expect(response.body).toContain('dsh-project-demo-project')
    expect(response.body).toContain('11111111-2222-3333-4444-555555555555')
    expect(response.body).toContain('2026-01-02T03:04:05.000Z')
    expect(response.body).toContain('high')
    expect(response.body).toContain(`${DEFAULT_COGNEE_UI_BASE_URL}/datasets/11111111-2222-3333-4444-555555555555`)
    expect(response.body).not.toContain(TOKEN)
  })

  it('escapes HTML injection in a memory body and renders no script', async () => {
    const h = harness({ env })
    const response = await h.request(`${PROVENANCE_PATH_PREFIX}mem-2`, 'GET', {
      ...authorized,
      accept: 'text/html',
    })
    expect(response.status).toBe(200)
    // No executable markup survives: the body is escaped text, not nodes.
    expect(response.body).not.toContain('<script>')
    expect(response.body).not.toContain('<img')
    expect(response.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(response.body).toContain('&lt;img src=x onerror=alert(2)&gt;')
  })

  it('answers an escaped 404 page for an unauthorized id', async () => {
    const h = harness({ env })
    const response = await h.request(`${PROVENANCE_PATH_PREFIX}mem-hidden?format=html`, 'GET', authorized)
    expect(response.status).toBe(404)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.body).toContain('No such memory')
  })
})

describe('memory list route', () => {
  it('lists only the caller-readable memories with label, scope, and date', async () => {
    const h = harness({ env })
    const response = await h.request(MEMORIES_JSON_PATH, 'GET', authorized)
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    const body = JSON.parse(response.body) as {
      count: number
      memories: Array<{ id: string; label: string; scope: string; createdAt: string; state: string }>
    }
    expect(body.count).toBe(2)
    expect(body.memories.map((memory) => memory.id).sort()).toEqual(['mem-1', 'mem-2'])
    expect(body.memories[0]).toMatchObject({ scope: 'project', createdAt: '2026-01-02T03:04:05.000Z', state: 'indexed' })
    expect(response.body).not.toContain('other project secret')
    expect(response.body).not.toContain('someone else secret')
    expect(response.body).not.toContain(TOKEN)
  })
})
