import { z } from 'zod'
import type { CogneeMemoryConfig } from '../config/schema.js'
import { MemoryError } from '../errors.js'
import type { MemoryCoordinator } from '../memory/coordinator.js'
import { sameScope, scopeFromName } from '../memory/scopes.js'
import type { Metrics } from '../telemetry/metrics.js'
import type { RecallHit, ScopeRef, ToolDefinitionLike, ToolRunContextLike } from '../types.js'
import { buildRecallPreview } from '../hooks/prompt-context.js'
import {
  SCOPE_VALUES,
  UNTRUSTED_MEMORY_NOTICE,
  parseToolArgs,
  rethrowToolError,
  scopeValue,
  scopeValueSchema,
  textBlock,
  toolIdentity,
} from './shared.js'

export interface RecallToolDependencies {
  readonly coordinator: Pick<MemoryCoordinator, 'recall' | 'policyFor'>
  readonly config: CogneeMemoryConfig
  readonly metrics?: Metrics
}

interface RecallToolValue {
  readonly count: number
  readonly memories: ReadonlyArray<{
    readonly id: string
    readonly text: string
    readonly scope: ScopeRef
    readonly createdAt: string
    readonly score: number
    readonly tags?: readonly string[]
  }>
}

const argsSchema = z
  .object({
    query: z.string().trim().min(1).max(8_000),
    scope: z.enum(SCOPE_VALUES).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict()

function toValue(hits: readonly RecallHit[]): RecallToolValue {
  return {
    count: hits.length,
    memories: hits.map((hit) => ({
      id: hit.record.id,
      text: hit.record.text,
      scope: scopeValue(hit.record.scope),
      createdAt: hit.record.createdAt,
      score: hit.score,
      ...(hit.record.tags === undefined ? {} : { tags: hit.record.tags }),
    })),
  }
}

export function createRecallTool(deps: RecallToolDependencies): ToolDefinitionLike {
  return {
    name: 'memory_recall',
    description:
      'Recall durable memories for the current session, agent, project, team, or global scope. ' +
      `${UNTRUSTED_MEMORY_NOTICE} ` +
      'Use this before guessing prior decisions or user preferences.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'What to recall. Must not be empty.' },
        scope: {
          type: 'string',
          enum: [...SCOPE_VALUES],
          description: 'Optional scope filter; defaults to every scope the caller may read.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum memories to return (1-20); defaults to the configured prompt size.',
        },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer' },
          memories: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                text: { type: 'string' },
                scope: scopeValueSchema,
                createdAt: { type: 'string' },
                score: { type: 'number' },
                tags: { type: 'array', items: { type: 'string' } },
              },
              required: ['id', 'text', 'scope', 'createdAt', 'score'],
            },
          },
        },
        required: ['count', 'memories'],
      },
      render: (_args: unknown, value: unknown) => {
        const typed = value as RecallToolValue
        if (typed.count === 0) return textBlock('No memories recalled.')
        const hits: RecallHit[] = typed.memories.map((memory) => ({
          record: {
            id: memory.id,
            text: memory.text,
            scope: memory.scope,
            createdAt: memory.createdAt,
            ...(memory.tags === undefined ? {} : { tags: memory.tags }),
          },
          score: memory.score,
        }))
        return textBlock(buildRecallPreview(hits))
      },
    },
    async execute(rawArgs: unknown, exec: ToolRunContextLike): Promise<RecallToolValue> {
      try {
        const args = parseToolArgs(argsSchema, rawArgs)
        const identity = toolIdentity(exec)
        const limit = args.limit ?? Math.min(5, deps.config.prompt.maxItems)
        let scopedFilter: ScopeRef | undefined
        if (args.scope !== undefined) {
          const scope = scopeFromName(args.scope, identity, deps.config)
          if (scope === undefined) {
            throw new MemoryError('FORBIDDEN', `caller has no ${args.scope} memory scope`)
          }
          const policy = await deps.coordinator.policyFor(identity)
          if (!policy.canRead(scope)) {
            throw new MemoryError('FORBIDDEN', `memory scope ${scope.scope} is not accessible`)
          }
          scopedFilter = scope
        }
        let hits = await deps.coordinator.recall({
          text: args.query,
          identity,
          limit,
          signal: exec.signal,
        })
        if (scopedFilter !== undefined) {
          hits = hits.filter((hit) => sameScope(hit.record.scope, scopedFilter))
        }
        return toValue(hits)
      } catch (error) {
        rethrowToolError(error)
      }
    },
  }
}
