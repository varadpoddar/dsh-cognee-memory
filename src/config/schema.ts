import { z } from 'zod'
import { MemoryError } from '../errors.js'
import type { TransportKind } from '../types.js'

const nonEmpty = z.string().trim().min(1)
const httpUrl = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => {
      try {
        const url = new URL(value)
        return (
          (url.protocol === 'http:' || url.protocol === 'https:') &&
          url.username === '' &&
          url.password === ''
        )
      } catch {
        return false
      }
    },
    { message: 'must be an absolute http(s) URL without embedded credentials' },
  )

const transportSchema = z.enum(['mcp-http', 'mcp-stdio', 'rest', 'auto'])
const authModeSchema = z.enum(['none', 'bearer', 'api-key'])
const failureModeSchema = z.enum(['open', 'closed'])

/**
 * Runtime configuration. Exporting the zod object as the plugin's `Config`
 * is valid for Cordis 4: `resolveConfig()` validates any Standard Schema
 * (`Config["~standard"].validate`), and zod 4 implements that interface.
 */
export const CogneeMemoryConfigSchema = z
  .object({
    /** Master switch. Disabled means no hooks, tools, or network activity. */
    enabled: z.boolean().default(true),

    /** Preferred transport. `auto` uses MCP when `mcpUrl` is set, otherwise REST. */
    transport: transportSchema.default('auto'),

    /** Cognee REST root, without a trailing slash requirement. */
    apiBaseUrl: httpUrl.default('http://127.0.0.1:8000'),

    /** Streamable HTTP MCP endpoint. Required only when transport resolves to `mcp-http`. */
    mcpUrl: httpUrl.optional(),

    authMode: authModeSchema.default('none'),

    /** Environment variable that holds the token. The token itself never enters config. */
    apiTokenEnv: nonEmpty.default('COGNEE_API_TOKEN'),

    connectionTimeoutMs: z.number().int().min(100).max(120_000).default(2_000),
    requestTimeoutMs: z.number().int().min(100).max(120_000).default(15_000),
    maxRetries: z.number().int().min(0).max(5).default(2),
    retryBackoffMs: z.number().int().min(0).max(30_000).default(250),
    circuitBreakerEnabled: z.boolean().default(true),
    circuitBreakerThreshold: z.number().int().min(1).max(100).default(5),
    circuitBreakerCooldownMs: z.number().int().min(100).max(600_000).default(30_000),

    /**
     * `open` degrades recall/prompt injection to empty on backend failure;
     * `closed` surfaces typed errors. Writes always surface real failures.
     */
    failureMode: failureModeSchema.default('open'),

    /** Optional identities used to derive project/team scope ids. */
    scopeDefaults: z
      .object({
        projectId: nonEmpty.optional(),
        teamId: nonEmpty.optional(),
      })
      .prefault({}),

    prompt: z
      .object({
        maxItems: z.number().int().min(1).max(20).default(5),
        maxTokens: z.number().int().min(32).max(4_000).default(600),
        order: z.number().int().min(-10_000).max(10_000).default(9_000),
      })
      .prefault({}),

    dedup: z
      .object({
        nearDuplicateThreshold: z.number().min(0.5).max(1).default(0.92),
        candidateLimit: z.number().int().min(1).max(100).default(20),
      })
      .prefault({}),

    retention: z
      .object({
        maxAgeDays: z.number().int().min(0).max(3_650).default(90),
        maxRecordsPerScope: z.number().int().min(1).max(10_000).default(500),
      })
      .prefault({}),

    security: z
      .object({
        /** `reject` refuses the write; `redact` replaces matches before sending. */
        redactionMode: z.enum(['reject', 'redact']).default('reject'),
        maxTextChars: z.number().int().min(1).max(100_000).default(16_000),
      })
      .prefault({}),

    tools: z.object({ enabled: z.boolean().default(true) }).prefault({}),
    telemetry: z.object({ enabled: z.boolean().default(true) }).prefault({}),
  })
  .superRefine((config, ctx) => {
    if (config.transport === 'mcp-http' && config.mcpUrl === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['mcpUrl'],
        message: 'mcpUrl is required when transport is mcp-http',
      })
    }
    if (config.transport === 'mcp-stdio') {
      ctx.addIssue({
        code: 'custom',
        path: ['transport'],
        message: 'mcp-stdio is reserved and not implemented in Phase 1; use mcp-http or rest',
      })
    }
  })

export type CogneeMemoryConfig = z.infer<typeof CogneeMemoryConfigSchema>

/** Parse unvalidated host config. Error text contains paths and schema messages only. */
export function parseConfig(input: unknown): CogneeMemoryConfig {
  const result = CogneeMemoryConfigSchema.safeParse(input ?? {})
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>'
      return `${path}: ${issue.message}`
    })
    throw new MemoryError('CONFIG', `invalid cognee memory config: ${issues.join('; ')}`, {
      retryable: false,
      details: { issues },
    })
  }
  return result.data
}

/** Resolve `auto` to the transport actually used for this configuration. */
export function resolveTransport(config: CogneeMemoryConfig): Exclude<TransportKind, 'auto'> {
  if (config.transport === 'auto') return config.mcpUrl === undefined ? 'rest' : 'mcp-http'
  return config.transport
}

/** Deep-freeze helpers for the exported defaults. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

export const DEFAULT_CONFIG: Readonly<CogneeMemoryConfig> = deepFreeze(
  CogneeMemoryConfigSchema.parse({}),
)
