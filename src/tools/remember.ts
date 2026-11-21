import { z } from 'zod'
import type { CogneeMemoryConfig } from '../config/schema.js'
import type { MemoryCoordinator } from '../memory/coordinator.js'
import { provenanceFromTool } from '../memory/provenance.js'
import type { Metrics } from '../telemetry/metrics.js'
import type { RememberResult, ScopeRef, ToolDefinitionLike, ToolRunContextLike } from '../types.js'
import {
  SCOPE_VALUES,
  parseToolArgs,
  rethrowToolError,
  scopeValueSchema,
  textBlock,
  toolIdentity,
} from './shared.js'

export interface RememberToolDependencies {
  readonly coordinator: Pick<MemoryCoordinator, 'remember'>
  readonly config: CogneeMemoryConfig
  readonly metrics?: Metrics
}

interface RememberToolValue {
  readonly stored: true
  readonly id: string
  readonly scope: ScopeRef
  readonly deduplicated: boolean
}

const argsSchema = z
  .object({
    text: z.string().trim().min(1).max(16_000),
    scope: z.enum(SCOPE_VALUES).optional(),
    tags: z.array(z.string().trim().min(1).max(64)).max(16).optional(),
  })
  .strict()

export function createRememberTool(deps: RememberToolDependencies): ToolDefinitionLike {
  return {
    name: 'memory_remember',
    description:
      'Store one durable fact, decision, preference, or task outcome for later sessions. ' +
      'Use only for information worth persisting; never store credentials, API keys, passwords, ' +
      'private keys, or transient conversation noise. The backend may deduplicate an identical memory.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: {
          type: 'string',
          description: 'Durable memory text (maximum 16000 characters).',
        },
        scope: {
          type: 'string',
          enum: [...SCOPE_VALUES],
          description: 'Where to store it; defaults to the project scope.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional labels (maximum 16).',
        },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stored: { type: 'boolean' },
          id: { type: 'string' },
          scope: scopeValueSchema,
          deduplicated: { type: 'boolean' },
        },
        required: ['stored', 'id', 'scope', 'deduplicated'],
      },
      render: (_args: unknown, value: unknown) => {
        const typed = value as RememberToolValue
        const scope = `${typed.scope.scope}:${typed.scope.id}`
        return textBlock(
          typed.deduplicated
            ? `Memory already present (${typed.id}, ${scope}); no duplicate written.`
            : `Memory stored (${typed.id}, ${scope}).`,
        )
      },
    },
    async execute(rawArgs: unknown, exec: ToolRunContextLike): Promise<RememberToolValue> {
      try {
        const args = parseToolArgs(argsSchema, rawArgs)
        const identity = toolIdentity(exec)
        const result: RememberResult = await deps.coordinator.remember({
          text: args.text,
          identity,
          ...(args.scope === undefined ? {} : { scopeName: args.scope }),
          ...(args.tags === undefined ? {} : { tags: args.tags }),
          provenance: provenanceFromTool('memory_remember', identity),
          signal: exec.signal,
        })
        return {
          stored: true,
          id: result.id,
          scope: result.scope,
          deduplicated: result.deduplicated,
        }
      } catch (error) {
        rethrowToolError(error)
      }
    },
  }
}
