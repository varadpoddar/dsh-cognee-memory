import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface MockServerRequest {
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  readonly body: string
}

export interface MockServerResponse {
  readonly status?: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  /** Send each entry as one SSE `data:` event. */
  readonly sse?: readonly string[]
  readonly delayMs?: number
}

export type MockHandler = (
  request: MockServerRequest,
  index: number,
) => MockServerResponse | Promise<MockServerResponse>

export interface MockServer {
  readonly url: string
  readonly requests: MockServerRequest[]
  close(): Promise<void>
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function writeResponse(response: ServerResponse, spec: MockServerResponse): void {
  const headers: Record<string, string> = { ...spec.headers }
  if (spec.sse !== undefined) {
    headers['content-type'] = headers['content-type'] ?? 'text/event-stream'
    response.writeHead(spec.status ?? 200, headers)
    for (const event of spec.sse) response.write(`data: ${event}\n\n`)
    response.end()
    return
  }
  if (spec.body !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json'
  }
  response.writeHead(spec.status ?? 200, headers)
  response.end(spec.body ?? '')
}

/**
 * In-process mock HTTP server for adapter tests. Binds only 127.0.0.1:0 and
 * records every request; no external network access is possible.
 */
export async function startMockServer(handler: MockHandler): Promise<MockServer> {
  const requests: MockServerRequest[] = []
  const server = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request)
      const recorded: MockServerRequest = {
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        headers: request.headers,
        body,
      }
      requests.push(recorded)
      try {
        const spec = await handler(recorded, requests.length - 1)
        if (spec.delayMs !== undefined && spec.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, spec.delayMs))
        }
        writeResponse(response, spec)
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'handler failed' }))
      }
    })()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
