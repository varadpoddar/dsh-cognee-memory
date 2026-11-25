import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { createFakePluginContext } from './helpers/fake-context.js'
import { startMockServer } from './helpers/mock-server.js'
import { SETTINGS_PAGE_PATH } from '../src/settings/http.js'
import type { PluginContextLike, ToolDefinitionLike, WebRouteLike } from '../src/types.js'

const TOKEN = 'operator-token'
const KEY = 'sk-cognee-never-rendered'
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  delete process.env.COGNEE_MEMORY_SETTINGS_FILE
  delete process.env.COGNEE_MEMORY_SETTINGS_TOKEN
  delete process.env.COGNEE_API_KEY
  delete process.env.COGNEE_MEMORY_API_BASE_URL
})

function makeRequest(method: string, url: string, body?: string): IncomingMessage {
  const request = new Readable({ read() {} }) as IncomingMessage & Readable
  request.method = method
  request.url = url
  request.headers = { 'content-type': 'application/x-www-form-urlencoded' }
  request.push(body ?? null)
  request.push(null)
  return request
}

function makeResponse(): { response: ServerResponse; done: Promise<{ status: number; body: string }> } {
  let resolve!: (value: { status: number; body: string }) => void
  const done = new Promise<{ status: number; body: string }>((r) => {
    resolve = r
  })
  const captured = { status: 200, body: '' }
  const response = {
    setHeader: () => response,
    writeHead: (status: number) => {
      captured.status = status
      return response
    },
    end: (chunk?: string) => {
      captured.body += chunk ?? ''
      resolve(captured)
      return response
    },
  } as unknown as ServerResponse
  return { response, done }
}

describe('plugin wiring for the runtime settings page', () => {
  it('registers the page and retargets memory_status after a saved change', async () => {
    const first = await startMockServer(() => ({ status: 200, body: JSON.stringify({ data: [] }) }))
    const second = await startMockServer(() => ({ status: 200, body: JSON.stringify({ data: [] }) }))
    cleanups.push(() => first.close(), () => second.close())

    const directory = mkdtempSync(join(tmpdir(), 'cognee-plugin-'))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    process.env.COGNEE_MEMORY_SETTINGS_FILE = join(directory, 'settings.json')
    process.env.COGNEE_MEMORY_SETTINGS_TOKEN = TOKEN
    process.env.COGNEE_API_KEY = KEY

    const fake = createFakePluginContext()
    const routes = new Map<string, WebRouteLike>()
    const pluginContext = {
      ...fake.ctx,
      webServer: {
        register(route: WebRouteLike) {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    } as PluginContextLike

    const dispose = apply(pluginContext, { apiBaseUrl: `${first.url}/api/v1` })
    cleanups.push(() => dispose?.())

    // 1. The page, its JSON, the provenance detail routes, and the lossless
    // transcript lookback route are mounted through ctx.webServer.register.
    expect([...routes.keys()].sort()).toEqual([
      '/plugins/cognee-memory/memories.json',
      '/plugins/cognee-memory/memory',
      '/plugins/cognee-memory/settings',
      '/plugins/cognee-memory/settings.json',
      '/plugins/cognee-memory/transcript',
    ])

    const statusTool = fake.tools.find((tool) => tool.name === 'memory_status') as ToolDefinitionLike
    expect(statusTool).toBeDefined()
    const signal = new AbortController().signal

    const before = (await statusTool.execute({}, { signal })) as { endpoint: string; reachable: boolean }
    expect(before.reachable).toBe(true)
    expect(before.endpoint).toBe(`${first.url}/api/v1`)

    // 2. Saving a new address through the page is enough: no restart, no apply() rerun.
    const body = new URLSearchParams({
      apiBaseUrl: `${second.url}/api/v1`,
      mcpUrl: '',
      enabled: 'on',
    }).toString()
    const route = routes.get(SETTINGS_PAGE_PATH) as WebRouteLike
    const { response, done } = makeResponse()
    await route.handler(makeRequest('POST', `${SETTINGS_PAGE_PATH}?token=${TOKEN}`, body), response)
    expect((await done).status).toBe(303)

    const after = (await statusTool.execute({}, { signal })) as { endpoint: string; reachable: boolean }
    expect(after.endpoint).toBe(`${second.url}/api/v1`)
    expect(after.reachable).toBe(true)
    expect(second.requests.length).toBeGreaterThan(0)

    // 3. The page still never carries the Cognee key.
    const pageResponse = makeResponse()
    await route.handler(makeRequest('GET', `${SETTINGS_PAGE_PATH}?token=${TOKEN}`), pageResponse.response)
    const page = await pageResponse.done
    expect(page.status).toBe(200)
    expect(page.body).toContain(`${second.url}/api/v1`)
    expect(page.body).not.toContain(KEY)
  })
})
