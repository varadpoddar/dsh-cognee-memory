import { MemoryError } from '../errors.js'
import { resolveTransport } from '../config/schema.js'
import type { MemoryAdapter } from '../types.js'
import { createCogneeMcpAdapter, type CogneeMcpAdapterRuntime } from './cognee-mcp.js'
import { createCogneeRestAdapter, type CogneeAdapterRuntime } from './cognee-rest.js'

export type MemoryAdapterRuntime = CogneeAdapterRuntime & CogneeMcpAdapterRuntime

export type { MemoryAdapter } from '../types.js'

/**
 * Build the transport selected by the config. `auto` resolves to MCP HTTP when
 * an `mcpUrl` is configured, otherwise REST. `mcp-stdio` is reserved for a
 * later phase and fails closed.
 */
export function createMemoryAdapter(runtime: MemoryAdapterRuntime): MemoryAdapter {
  const transport = resolveTransport(runtime.config)
  if (transport === 'rest') return createCogneeRestAdapter(runtime)
  if (transport === 'mcp-http') return createCogneeMcpAdapter(runtime)
  throw new MemoryError(
    'CONFIG',
    'mcp-stdio transport is not implemented in Phase 1; use mcp-http or rest',
  )
}
