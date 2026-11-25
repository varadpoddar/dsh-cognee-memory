import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { parseConfig } from '../src/config/schema.js'
import { SettingsStore } from '../src/settings/store.js'
import {
  PROVENANCE_PATH_PREFIX,
  TRANSCRIPT_PATH_PREFIX,
  registerProvenanceRoutes,
} from '../src/settings/provenance-http.js'
import { ProvenanceIndex, type ProvenanceAccess } from '../src/memory/provenance-index.js'
import { TranscriptStore, transcriptHash } from '../src/memory/transcript-store.js'
import { buildPointer, type TranscriptPointer } from '../src/memory/pointer.js'
import { segmentTurns } from '../src/memory/segmenter.js'
import type { RecallHit, ScopeRef, WebRouteLike, WebServerLike } from '../src/types.js'

const temporary: string[] = []
const TOKEN = 'transcript-token-abc'
const PROJECT: ScopeRef = { scope: 'project', id: 'demo-project' }
const SESSION = 'session-1'

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

function hit(id: string, text: string): RecallHit {
  return { record: { id, text, scope: PROJECT, createdAt: '2026-01-02T03:04:05.000Z' }, score: 0.9 }
}

const USER_TEXT = 'what changed in the deploy? 🚀'
const ANSWER_TEXT = 'the timer moved to 04:00\nand nothing else.'

function pointerFor(rows: Array<{ turnIndex: number; role: 'user' | 'assistant'; text: string }>): TranscriptPointer {
  // One pointer over the whole turn (user + assistant), as a segment summary
  // for a single turn would be; char offsets are the canonical transcript range.
  const turns = segmentTurns(rows).flatMap((segment) => segment.turns)
  const text = turns.map((turn) => turn.text).join('\n\n')
  return buildPointer({
    sessionId: SESSION,
    segmentIndex: 0,
    turns,
    charStart: 0,
    charEnd: text.length,
  })
}

interface HarnessOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly access?: ProvenanceAccess
  readonly withStore?: boolean
  readonly withSession?: boolean
  readonly pointerText?: string
  readonly attachPointer?: boolean
}

function harness(options: HarnessOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'cognee-transcript-http-'))
  temporary.push(directory)
  const env = options.env ?? {}
  const settings = new SettingsStore({
    filePath: join(directory, 'settings.json'),
    baseConfig: parseConfig({ apiBaseUrl: 'http://profile.local:8000/api/v1' }),
    env,
  })
  const index = new ProvenanceIndex({ filePath: join(directory, 'provenance.json') })
  index.recordRecall([hit('mem-with-pointer', 'the deploy timer moved'), hit('mem-plain', 'unrelated')], {
    identity: { principalId: 'operator' },
  })
  const store = new TranscriptStore({ dir: join(directory, 'transcripts') })
  const rows = [
    { turnIndex: 0, role: 'user' as const, text: USER_TEXT },
    { turnIndex: 0, role: 'assistant' as const, text: ANSWER_TEXT },
  ]
  if (options.withSession !== false) {
    store.appendTurn({ sessionId: SESSION, turnIndex: 0, role: 'user', text: USER_TEXT })
    store.appendTurn({ sessionId: SESSION, turnIndex: 0, role: 'assistant', text: ANSWER_TEXT })
  }
  const pointer = pointerFor(rows)
  if (options.attachPointer !== false) {
    index.setPointer(
      'mem-with-pointer',
      options.pointerText === undefined
        ? pointer
        : { ...pointer, content_hash: transcriptHash(options.pointerText) },
    )
  }
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
  registerProvenanceRoutes(webServer, {
    index,
    store: settings,
    env,
    access: async () => access,
    ...(options.withStore === false ? {} : { transcripts: store }),
  })
  return {
    index,
    store,
    routes,
    pointer,
    provenancePath: join(directory, 'provenance.json'),
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
const env = { COGNEE_MEMORY_SETTINGS_TOKEN: TOKEN }
const transcriptPath = (session: string, turn: string): string =>
  `${TRANSCRIPT_PATH_PREFIX}/${encodeURIComponent(session)}/${turn}`

describe('transcript JSON route registration', () => {
  it('registers a prefix route with no trailing slash', () => {
    const h = harness({ env })
    const prefix = h.routes.find(
      (route) => route.kind === 'prefix' && route.path === TRANSCRIPT_PATH_PREFIX,
    )
    expect(prefix?.path).toBe('/plugins/cognee-memory/transcript')
    expect(prefix?.path.endsWith('/')).toBe(false)
  })
})

describe('transcript JSON route authorization', () => {
  it('answers 503 when the settings token is unset', async () => {
    const h = harness({ env: {} })
    const response = await h.request(transcriptPath(SESSION, '0'))
    expect(response.status).toBe(503)
    expect(JSON.parse(response.body)).toEqual({ error: 'settings token not configured' })
  })

  it('answers 401 without a token and 200 with one', async () => {
    const h = harness({ env })
    expect((await h.request(transcriptPath(SESSION, '0'))).status).toBe(401)
    const response = await h.request(transcriptPath(SESSION, '0'), 'GET', authorized)
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).not.toContain(TOKEN)
  })

  it('answers a generic 404 when the caller has no readable scope', async () => {
    const h = harness({ env, access: { principalId: 'operator', readableScopes: [] } })
    const response = await h.request(transcriptPath(SESSION, '0'), 'GET', authorized)
    expect(response.status).toBe(404)
    expect(JSON.parse(response.body)).toEqual({ error: 'not found' })
  })

  it('answers 503 when the transcript store is not configured', async () => {
    const h = harness({ env, withStore: false })
    const response = await h.request(transcriptPath(SESSION, '0'), 'GET', authorized)
    expect(response.status).toBe(503)
  })
})

describe('transcript JSON route resolution', () => {
  it('returns the exact stored turn with offsets and hash', async () => {
    const h = harness({ env })
    const response = await h.request(transcriptPath(SESSION, '0'), 'GET', authorized)
    expect(response.status).toBe(200)
    const body = JSON.parse(response.body) as Record<string, unknown>
    expect(body.available).toBe(true)
    expect(body.session_id).toBe(SESSION)
    expect(body.turn_index).toBe(0)
    expect(body.text).toBe(USER_TEXT)
    expect(body.char_start).toBe(0)
    expect(body.char_end).toBe(USER_TEXT.length)
    expect(body.content_hash).toBe(transcriptHash(USER_TEXT))
    expect(typeof body.timestamp).toBe('string')
  })

  it('answers 404 for an unknown session, turn, or malformed path', async () => {
    const h = harness({ env })
    expect((await h.request(transcriptPath('other-session', '0'), 'GET', authorized)).status).toBe(404)
    expect((await h.request(transcriptPath(SESSION, '9'), 'GET', authorized)).status).toBe(404)
    expect((await h.request(transcriptPath(SESSION, 'not-a-turn'), 'GET', authorized)).status).toBe(404)
    expect((await h.request(`${TRANSCRIPT_PATH_PREFIX}/${SESSION}`, 'GET', authorized)).status).toBe(404)
    expect((await h.request(transcriptPath('bad id', '0'), 'GET', authorized)).status).toBe(404)
    expect((await h.request(`${TRANSCRIPT_PATH_PREFIX}/..%2Fetc/0`, 'GET', authorized)).status).toBe(404)
    expect((await h.request(transcriptPath(SESSION, '0'), 'POST', authorized)).status).toBe(405)
  })
})

describe('memory detail Source section', () => {
  const pagePath = `${PROVENANCE_PATH_PREFIX}mem-with-pointer?format=page`

  it('renders the pointer, turn range, char offsets, and exact text', async () => {
    const h = harness({ env })
    const response = await h.request(pagePath, 'GET', authorized)
    expect(response.status).toBe(200)
    expect(response.body).toContain('<h2>Source</h2>')
    expect(response.body).toContain(SESSION)
    expect(response.body).toContain('Turn range')
    expect(response.body).toContain('0 .. 0')
    expect(response.body).toContain('Char offsets')
    expect(response.body).toContain('0 ..')
    expect(response.body).toContain('what changed in the deploy? 🚀')
    expect(response.body).toContain('the timer moved to 04:00')
    expect(response.body).toContain('still matches the pointer hash')
    expect(response.body).toContain(h.pointer.content_hash)
  })

  it('serves the same resolution in JSON', async () => {
    const h = harness({ env })
    const response = await h.request(`${PROVENANCE_PATH_PREFIX}mem-with-pointer`, 'GET', authorized)
    expect(response.status).toBe(200)
    const body = JSON.parse(response.body) as {
      pointer: TranscriptPointer
      source: { available: boolean; text: string; charStart: number; charEnd: number; hashMatches: boolean }
    }
    expect(body.pointer.session_id).toBe(SESSION)
    expect(body.pointer.turn_start).toBe(0)
    expect(body.pointer.turn_end).toBe(0)
    expect(body.pointer.segment_index).toBe(0)
    expect(body.source.available).toBe(true)
    expect(body.source.text).toBe(`${USER_TEXT}\n\n${ANSWER_TEXT}`)
    expect(body.source.hashMatches).toBe(true)
    expect(body.source.charStart).toBe(0)
    expect(body.source.charEnd).toBe(`${USER_TEXT}\n\n${ANSWER_TEXT}`.length)
  })

  it('renders an honest "transcript unavailable" note when the session is missing', async () => {
    const h = harness({ env, withSession: false })
    const response = await h.request(pagePath, 'GET', authorized)
    expect(response.status).toBe(200)
    expect(response.body).toContain('<h2>Source</h2>')
    expect(response.body).toContain('transcript unavailable')
    expect(response.body).toContain(SESSION)
    expect(response.body).toContain('Turn range')
  })

  it('flags a stale pointer instead of silently pairing edited text', async () => {
    const h = harness({ env, pointerText: 'the old edited text' })
    const response = await h.request(pagePath, 'GET', authorized)
    expect(response.status).toBe(200)
    expect(response.body).toContain('Stale')
    expect(response.body).not.toContain('still matches the pointer hash')
  })

  it('renders no Source section for a memory without a pointer', async () => {
    const h = harness({ env })
    const response = await h.request(`${PROVENANCE_PATH_PREFIX}mem-plain?format=page`, 'GET', authorized)
    expect(response.status).toBe(200)
    expect(response.body).toContain('Source references')
    expect(response.body).not.toContain('<h2>Source</h2>')
  })

  it('persists the pointer across a provenance index restart', () => {
    const h = harness({ env })
    const reopened = new ProvenanceIndex({ filePath: h.provenancePath })
    const entry = reopened.get('mem-with-pointer', {
      principalId: 'operator',
      readableScopes: [PROJECT],
    })
    expect(entry?.pointer).toEqual(h.pointer)
  })

  it('keeps the existing 404 for an unknown memory id', async () => {
    const h = harness({ env })
    const response = await h.request(`${PROVENANCE_PATH_PREFIX}mem-missing`, 'GET', authorized)
    expect(response.status).toBe(404)
  })
})
