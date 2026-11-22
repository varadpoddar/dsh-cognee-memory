import { z } from 'zod'
import type { CogneeMemoryConfig } from '../config/schema.js'
import type { MemoryCoordinator } from '../memory/coordinator.js'
import type { ExtractionSnapshot } from '../memory/extraction-service.js'
import type { Metrics } from '../telemetry/metrics.js'
import type { JsonValue, ToolDefinitionLike, ToolRunContextLike } from '../types.js'
import { parseToolArgs, rethrowToolError, textBlock } from './shared.js'

export interface StatusToolDependencies {
  readonly coordinator: Pick<MemoryCoordinator, 'status'>
  readonly config: CogneeMemoryConfig
  readonly metrics?: Metrics
  readonly extraction?: { status(): Promise<ExtractionSnapshot> }
}

const argsSchema = z.object({}).strict()

interface StatusToolValue {
  readonly enabled: boolean
  readonly transport: string
  readonly reachable: boolean
  readonly endpoint: string
  readonly authMode: string
  readonly failureMode: string
  readonly counters: Readonly<Record<string, number>>
  readonly details: Readonly<Record<string, JsonValue>>
}

function countSummary(counters: Readonly<Record<string, number>>): string {
  const entries = Object.entries(counters).filter(([, value]) => value !== 0)
  return entries.length === 0
    ? 'counters: (none)'
    : `counters: ${entries.map(([name, value]) => `${name}=${value}`).join(', ')}`
}

export function createStatusTool(deps: StatusToolDependencies): ToolDefinitionLike {
  return {
    name: 'memory_status',
    description:
      'Report Cognee memory enablement, transport, reachability, failure mode, and counters. ' +
      'Never returns tokens or credential values.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean' },
          transport: { type: 'string' },
          reachable: { type: 'boolean' },
          endpoint: { type: 'string' },
          authMode: { type: 'string' },
          failureMode: { type: 'string' },
          counters: { type: 'object', additionalProperties: true },
          details: { type: 'object', additionalProperties: true },
        },
        required: [
          'enabled',
          'transport',
          'reachable',
          'endpoint',
          'authMode',
          'failureMode',
          'counters',
          'details',
        ],
      },
      render: (_args: unknown, value: unknown) => {
        const typed = value as StatusToolValue
        return textBlock(
          [
            'Cognee memory status',
            `enabled: ${typed.enabled}`,
            `transport: ${typed.transport}`,
            `reachable: ${typed.reachable}`,
            `endpoint: ${typed.endpoint}`,
            `auth: ${typed.authMode}`,
            `failure mode: ${typed.failureMode}`,
            countSummary(typed.counters),
            `memory namespaces: ${JSON.stringify((typed.details as { namespaces?: unknown }).namespaces ?? {})}`,
            `extraction: ${JSON.stringify((typed.details as { extraction?: unknown }).extraction ?? {})}`,
          ].join('\n'),
        )
      },
    },
    async execute(rawArgs: unknown, exec: ToolRunContextLike): Promise<StatusToolValue> {
      try {
        parseToolArgs(argsSchema, rawArgs)
        const status = await deps.coordinator.status(exec.signal)
        const extraction =
          deps.extraction === undefined
            ? undefined
            : ((await deps.extraction.status()) as unknown as JsonValue)
        return {
          enabled: deps.config.enabled,
          transport: status.transport,
          reachable: status.adapter.reachable,
          endpoint: status.endpoint,
          authMode: status.authMode,
          failureMode: status.failureMode,
          counters: status.metrics.counters,
          details: {
            ...(status.adapter.details ?? {}),
            ...(status.namespaces === undefined ? {} : { namespaces: status.namespaces as JsonValue }),
            ...(extraction === undefined ? {} : { extraction }),
          },
        }
      } catch (error) {
        rethrowToolError(error)
      }
    },
  }
}
