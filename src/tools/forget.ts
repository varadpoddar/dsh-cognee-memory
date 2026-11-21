import { z } from 'zod'
import type { CogneeMemoryConfig } from '../config/schema.js'
import type { MemoryCoordinator } from '../memory/coordinator.js'
import type { Metrics } from '../telemetry/metrics.js'
import type { ForgetResult, ToolDefinitionLike, ToolRunContextLike } from '../types.js'
import {
  SCOPE_VALUES,
  parseToolArgs,
  rethrowToolError,
  scopeValueSchema,
  textBlock,
  toolIdentity,
} from './shared.js'

export interface ForgetToolDependencies {
  readonly coordinator: Pick<MemoryCoordinator, 'forget'>
  readonly config: CogneeMemoryConfig
  readonly metrics?: Metrics
}

const argsSchema = z
  .object({
    id: z.string().trim().min(1).max(512),
    scope: z.enum(SCOPE_VALUES).optional(),
  })
  .strict()

export function createForgetTool(deps: ForgetToolDependencies): ToolDefinitionLike {
  return {
    name: 'memory_forget',
    description:
      'Forget one memory by id within a scope. Cognee may not support per-memory deletion; ' +
      'an UNSUPPORTED_OPERATION error is final and must not be retried as a dataset deletion.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Exact memory id returned by memory_recall or memory_remember.' },
        scope: {
          type: 'string',
          enum: [...SCOPE_VALUES],
          description: 'Scope that owns the memory; defaults to the project scope.',
        },
      },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          forgotten: { type: 'boolean' },
          id: { type: 'string' },
          scope: scopeValueSchema,
        },
        required: ['forgotten', 'id', 'scope'],
      },
      render: (_args: unknown, value: unknown) => {
        const typed = value as ForgetResult
        return textBlock(
          typed.forgotten
            ? `Memory ${typed.id} forgotten in ${typed.scope.scope}:${typed.scope.id}.`
            : `Backend did not confirm deletion of ${typed.id}.`,
        )
      },
    },
    async execute(rawArgs: unknown, exec: ToolRunContextLike): Promise<ForgetResult> {
      try {
        const args = parseToolArgs(argsSchema, rawArgs)
        return await deps.coordinator.forget({
          id: args.id,
          identity: toolIdentity(exec),
          ...(args.scope === undefined ? {} : { scopeName: args.scope }),
          signal: exec.signal,
        })
      } catch (error) {
        rethrowToolError(error)
      }
    },
  }
}
