import { MemoryError, UnsupportedOperationError, toMemoryError } from '../errors.js'
import type { CogneeMemoryConfig } from '../config/schema.js'
import { scopeKey } from '../memory/scopes.js'
import type { Metrics } from '../telemetry/metrics.js'
import type {
  AdapterStatus,
  ForgetInput,
  ForgetResult,
  HealthResult,
  MemoryAdapter,
  RecallHit,
  RecallQuery,
  RememberInput,
  RememberResult,
} from '../types.js'
import { COGNEE_MCP_TOOLS } from './cognee-paths.js'
import {
  localId,
  parseForgetResponse,
  parseRecallResponse,
  parseRememberResponse,
} from './cognee-response.js'
import { HttpJsonClient, type HttpResult } from './http-client.js'

export interface CogneeMcpAdapterRuntime {
  readonly config: CogneeMemoryConfig
  readonly env?: NodeJS.ProcessEnv
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>
  readonly random?: () => number
  readonly metrics?: Metrics
  /** Live endpoint source; see `HttpJsonClientOptions.endpoint`. */
  readonly endpoint?: () => string
}

interface JsonRpcResponse {
  readonly jsonrpc?: string
  readonly id?: number | string | null
  readonly result?: unknown
  readonly error?: { readonly code?: number; readonly message?: string }
}

/** Parse a Streamable-HTTP MCP response body (plain JSON or SSE data events). */
export function parseMcpHttpBody(text: string, contentType: string): unknown {
  const trimmed = text.trim()
  if (contentType.toLowerCase().includes('text/event-stream') || trimmed.startsWith('data:')) {
    const payloads: string[] = []
    for (const block of trimmed.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n')
      if (data !== '') payloads.push(data)
    }
    for (let index = payloads.length - 1; index >= 0; index -= 1) {
      const payload = payloads[index]
      if (payload === undefined) continue
      try {
        return JSON.parse(payload)
      } catch {
        // Try the previous event; a server may emit comments/keepalives.
      }
    }
    throw new MemoryError('BACKEND', 'invalid MCP response')
  }
  try {
    return JSON.parse(trimmed)
  } catch {
    throw new MemoryError('BACKEND', 'invalid MCP response')
  }
}

function mcpError(payload: unknown, tool: string): never {
  if (payload !== null && typeof payload === 'object') {
    const error = (payload as { error?: { code?: unknown; message?: unknown } }).error
    if (error !== undefined) {
      if (error.code === -32601) {
        throw new UnsupportedOperationError(tool, 'MCP server did not advertise this tool')
      }
      throw new MemoryError('BACKEND', 'MCP server rejected the tool call', {
        details: {
          ...(typeof error.code === 'number' ? { rpcCode: error.code } : {}),
          tool,
        },
      })
    }
  }
  throw new MemoryError('BACKEND', 'invalid MCP tool response')
}

function parseToolPayload(payload: JsonRpcResponse, tool: string): unknown {
  if (payload.error !== undefined) mcpError(payload, tool)
  const result = payload.result
  if (result === undefined) throw new MemoryError('BACKEND', 'empty MCP tool result')
  if (result !== null && typeof result === 'object') {
    const record = result as { isError?: unknown; structuredContent?: unknown; content?: unknown }
    if (record.isError === true) throw new MemoryError('BACKEND', 'MCP memory tool reported an error')
    if (record.structuredContent !== undefined) return record.structuredContent
    if (Array.isArray(record.content)) {
      const text = record.content
        .map((item) =>
          item !== null && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string'
            ? (item as { text: string }).text
            : '',
        )
        .filter((part) => part !== '')
        .join('\n')
      if (text !== '') {
        try {
          return JSON.parse(text)
        } catch {
          return { text }
        }
      }
    }
    return result
  }
  return result
}

/**
 * Minimal Streamable-HTTP MCP adapter. Tool names and result shapes are
 * UNVERIFIED for Cognee 1.6. `mcp-stdio` is intentionally not implemented.
 */
export class CogneeMcpAdapter implements MemoryAdapter {
  readonly transport = 'mcp-http' as const
  private readonly config: CogneeMemoryConfig
  private readonly client: HttpJsonClient
  private readonly now: () => number
  private readonly metrics: Metrics | undefined
  private sessionId: string | undefined
  private initPromise: Promise<void> | undefined

  constructor(runtime: CogneeMcpAdapterRuntime) {
    this.config = runtime.config
    this.client = new HttpJsonClient(runtime)
    this.now = runtime.now ?? Date.now
    this.metrics = runtime.metrics
  }

  async probePrincipal(): Promise<string | undefined> {
    return undefined
  }

  async remember(input: RememberInput): Promise<RememberResult> {
    if (input.scope.scope === 'session') {
      throw new Error('session memory is ephemeral and never written to Cognee')
    }
    const payload = await this.callTool(
      COGNEE_MCP_TOOLS.remember,
      {
        text: input.text,
        datasetName: scopeKey(input.scope),
        ...(input.tags === undefined ? {} : { tags: input.tags }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        ...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
      },
      input.signal,
    )
    const nowIso = new Date(this.now()).toISOString()
    const parsed = parseRememberResponse(
      payload,
      input.scope,
      localId(input.scope, input.text, input.dedupeKey),
      nowIso,
    )
    return { id: parsed.id, scope: input.scope, createdAt: parsed.createdAt, deduplicated: parsed.deduplicated }
  }

  async recall(query: RecallQuery): Promise<readonly RecallHit[]> {
    const payload = await this.callTool(
      COGNEE_MCP_TOOLS.recall,
      {
        query: query.text,
        datasets: query.scopes.map(scopeKey),
        limit: query.limit,
        ...(query.minScore === undefined ? {} : { minScore: query.minScore }),
      },
      query.signal,
    )
    return parseRecallResponse(
      payload,
      query.scopes,
      new Date(this.now()).toISOString(),
      Math.min(100, query.limit * 5),
    )
  }

  async forget(input: ForgetInput): Promise<ForgetResult> {
    const payload = await this.callTool(
      COGNEE_MCP_TOOLS.forget,
      { dataId: input.id, datasetName: scopeKey(input.scope) },
      input.signal,
      [404, 405, 501],
      'forget',
    )
    return { id: input.id, scope: input.scope, forgotten: parseForgetResponse(payload) }
  }

  async status(signal?: AbortSignal): Promise<AdapterStatus> {
    const checkedAt = new Date(this.now()).toISOString()
    try {
      await this.ensureInitialized(signal)
      return {
        transport: 'mcp-http',
        reachable: true,
        checkedAt,
        details: { initialized: true, session: this.sessionId === undefined ? 'none' : 'present' },
      }
    } catch (error) {
      const normalized = toMemoryError(error, 'UNAVAILABLE')
      return {
        transport: 'mcp-http',
        reachable: false,
        checkedAt,
        details: { errorCode: normalized.code },
      }
    }
  }

  async health(): Promise<HealthResult> {
    const started = this.now()
    try {
      await this.ensureInitialized()
      return { ok: true, latencyMs: Math.max(0, this.now() - started) }
    } catch (error) {
      const normalized = toMemoryError(error, 'UNAVAILABLE')
      return {
        ok: false,
        latencyMs: Math.max(0, this.now() - started),
        message: normalized.code,
      }
    }
  }

  private async ensureInitialized(signal?: AbortSignal): Promise<void> {
    if (this.initPromise !== undefined) return this.initPromise
    this.initPromise = this.initialize(signal).catch((error: unknown) => {
      this.initPromise = undefined
      throw error
    })
    return this.initPromise
  }

  private async initialize(signal?: AbortSignal): Promise<void> {
    const response = await this.postRpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'dsh-cognee-memory', version: '0.1.0' },
        },
      },
      signal,
    )
    const session = response.headers.get('mcp-session-id')
    if (session !== null && session !== '') this.sessionId = session
    const payload = parseMcpHttpBody(response.text, response.headers.get('content-type') ?? '')
    if (payload !== null && typeof payload === 'object' && 'error' in payload) mcpError(payload, 'initialize')
    await this.postRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, signal, true)
  }

  private async postRpc(
    body: unknown,
    signal: AbortSignal | undefined,
    notification = false,
  ): Promise<HttpResult> {
    const headers: Record<string, string> = {
      accept: 'application/json, text/event-stream',
      ...(this.sessionId === undefined ? {} : { 'mcp-session-id': this.sessionId }),
    }
    return this.client.request({
      method: 'POST',
      path: '',
      body,
      operation: notification ? 'mcp-notification' : 'mcp-request',
      headers,
      timeoutMs: this.config.connectionTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
    })
  }

  private async callTool(
    tool: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    unsupportedStatuses?: readonly number[],
    operation?: string,
  ): Promise<unknown> {
    await this.ensureInitialized(signal)
    const body = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }
    const headers: Record<string, string> = {
      accept: 'application/json, text/event-stream',
      ...(this.sessionId === undefined ? {} : { 'mcp-session-id': this.sessionId }),
    }
    let response: HttpResult
    try {
      response = await this.client.request({
        method: 'POST',
        path: '',
        body,
        operation: operation ?? tool,
        headers,
        ...(signal === undefined ? {} : { signal }),
        ...(unsupportedStatuses === undefined ? {} : { unsupportedStatuses }),
      })
    } catch (error) {
      this.metrics?.recordError(toMemoryError(error, 'BACKEND').code)
      throw error
    }
    const payload = parseMcpHttpBody(response.text, response.headers.get('content-type') ?? '')
    return parseToolPayload(payload as JsonRpcResponse, tool)
  }
}

export function createCogneeMcpAdapter(runtime: CogneeMcpAdapterRuntime): CogneeMcpAdapter {
  const transport = runtime.config.transport
  if (transport === 'mcp-stdio') {
    throw new MemoryError('CONFIG', 'mcp-stdio transport is not implemented in Phase 1; use mcp-http or rest')
  }
  if (runtime.config.mcpUrl === undefined) {
    throw new MemoryError('CONFIG', 'mcpUrl is required for the mcp-http transport')
  }
  const scoped: CogneeMcpAdapterRuntime = {
    ...runtime,
    config: { ...runtime.config, apiBaseUrl: runtime.config.mcpUrl },
  }
  return new CogneeMcpAdapter(scoped)
}
