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

/**
 * The one URL contract for Cognee endpoints: absolute http(s), no embedded
 * credentials. Exported so the runtime settings page validates exactly the rule
 * the profile config validates instead of drifting from it.
 */
export const httpUrlSchema = httpUrl

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

    /**
     * Runtime toggles (Milestone 9 / settings page).
     *
     * `autoRecall` gates automatic prompt injection (prefetch + assembly
     * substitution); explicit `memory_recall` tool calls stay available.
     * `autoWrite` gates automatic extraction from committed turns; explicit
     * `memory_remember` calls stay available, and a queue that was already
     * committed is still drained so no accepted write is lost.
     */
    autoRecall: z.boolean().default(true),
    autoWrite: z.boolean().default(true),

    /** Preferred transport. `auto` uses MCP when `mcpUrl` is set, otherwise REST. */
    transport: transportSchema.default('auto'),

    /** Cognee REST root. The client resolves the verified `/api/v1/...` paths against it. */
    apiBaseUrl: httpUrl.default('http://127.0.0.1:8000/api/v1'),

    /** Streamable HTTP MCP endpoint. Required only when transport resolves to `mcp-http`. */
    mcpUrl: httpUrl.optional(),

    /** Cognee 1.6.10 with EBAC enabled rejects every call without credentials. */
    authMode: authModeSchema.default('api-key'),

    /** Environment variable that holds the token. The token itself never enters config. */
    apiTokenEnv: nonEmpty.default('COGNEE_API_KEY'),

    connectionTimeoutMs: z.number().int().min(100).max(120_000).default(2_000),
    /**
     * Cognee's `/remember` runs add+cognify synchronously and took 2.0-3.0 s on
     * the live instance; `GRAPH_COMPLETION` search took 4.2-5.9 s. Keep a wide
     * ceiling here and bound recall separately with `recall.maxRecallLatencyMs`.
     */
    requestTimeoutMs: z.number().int().min(100).max(600_000).default(120_000),
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

    /**
     * Read path. `maxRecallLatencyMs` is a hard budget: on expiry recall returns
     * no hits in `open` failure mode instead of stalling a turn. Live latencies
     * observed: CHUNKS 0.21 s, GRAPH_COMPLETION 4.2 s, /recall 5.6 s.
     */
    recall: z
      .object({
        searchType: z
          .enum(['CHUNKS', 'GRAPH_COMPLETION', 'HYBRID_COMPLETION', 'RAG_COMPLETION', 'SUMMARIES'])
          .default('CHUNKS'),
        maxRecallLatencyMs: z.number().int().min(100).max(120_000).default(3_000),
      })
      .prefault({}),

    /**
     * Write path completion. `/remember` is synchronous on the live instance,
     * but a 200 is not proof: the adapter polls pipeline + memory status until
     * `searchable:true` or this budget expires.
     */
    ingestion: z
      .object({
        timeoutMs: z.number().int().min(500).max(900_000).default(180_000),
        pollMs: z.number().int().min(50).max(30_000).default(500),
        /**
         * Turn journal: every text part of a conversation (your messages and,
         * with `includeAssistant`, the agent's answers) is appended to the
         * durable ingest queue as its own task. The nightly drain ingests
         * them and removes a task only after a complete ingest, so pending,
         * in-flight and failed work survives a crash or a power cut.
         * Off by default: an existing deployment changes behaviour only when
         * the operator asks for it.
         */
        journal: z
          .object({
            enabled: z.boolean().default(false),
            includeAssistant: z.boolean().default(true),
            /** Long messages are split at this size; nothing is dropped. */
            chunkChars: z.number().int().min(500).max(50_000).default(8_000),
            /** Scrub shaped secrets before the text ever touches disk. */
            redactAtEnqueue: z.boolean().default(true),
            /** Defaults to `scopes.defaultWriteScope`. */
            scope: z.enum(['agent', 'user', 'project', 'team']).optional(),
          })
          .prefault({}),
        /** Ingest-queue lifecycle shared by the journal and the nightly drain. */
        queue: z
          .object({
            path: nonEmpty.optional(),
            /** fdatasync each append: a power cut must not lose an acknowledged turn. */
            syncWrites: z.boolean().default(true),
            baseBackoffMs: z.number().int().min(10).max(600_000).default(30_000),
            maxBackoffMs: z.number().int().min(100).max(3_600_000).default(3_600_000),
            /** No practical limit: a backlog waits instead of being abandoned. */
            maxAttempts: z.number().int().min(1).max(1_000_000).default(1_000_000),
            /** How long a completed task's hash stays for replay idempotency. */
            tombstoneRetentionDays: z.number().int().min(1).max(3_650).default(30),
          })
          .prefault({}),
      })
      .prefault({}),

    /**
     * Deployment identity. `principalId` is trusted configuration, never model
     * text; when omitted the plugin uses the authenticated Cognee user behind
     * the API key. `agentId` is the stable agent namespace when the committed
     * session header has no `agentPreset`.
     */
    identity: z
      .object({
        principalId: nonEmpty.optional(),
        agentId: nonEmpty.optional(),
      })
      .prefault({}),

    /** Optional identities used to derive project/team scope ids. */
    scopeDefaults: z
      .object({
        projectId: nonEmpty.optional(),
        teamId: nonEmpty.optional(),
      })
      .prefault({}),

    /**
     * Namespace policy. Global memory is deny-by-default and requires the
     * deployment to opt in. Session memory is always ephemeral and never
     * reaches Cognee or any other durable backend.
     */
    scopes: z
      .object({
        allowGlobal: z.boolean().default(false),
        defaultWriteScope: z.enum(['agent', 'user', 'project', 'team']).default('project'),
      })
      .prefault({}),

    /**
     * Automatic extraction from committed session events. Deterministic
     * commands ("remember that…", "forget…", "actually it's…") never depend on
     * a model. The LLM pass is on by default because most durable facts are
     * stated implicitly, and it may only target a private/local endpoint.
     */
    extraction: z
      .object({
        enabled: z.boolean().default(true),
        deterministic: z.boolean().default(true),
        scope: z.enum(['agent', 'user', 'project', 'team']).default('project'),
        llm: z
          .object({
            enabled: z.boolean().default(true),
            endpoint: httpUrl.default('http://10.20.10.40:8888/v1'),
            model: nonEmpty.default('unsloth/Qwen3.8-27B-GGUF'),
            /** Environment variable holding the Studio key; never the key itself. */
            apiKeyEnv: nonEmpty.default('UNSLOTH_LARGE_API_KEY'),
            timeoutMs: z.number().int().min(500).max(120_000).default(15_000),
            maxCandidates: z.number().int().min(1).max(10).default(3),
            /**
             * Hard cap on the post-response settle wait (after the assistant
             * response, before the turn boundary). The local extractor takes
             * ~3.3 s, so this is deliberately short: the pass keeps running in
             * the background (and a one-shot headless process still waits for
             * it), while a turn adds at most this much.
             */
            settleMs: z.number().int().min(50).max(30_000).default(1_000),
          })
          .prefault({}),
        queue: z
          .object({
            dir: nonEmpty.optional(),
            maxPending: z.number().int().min(1).max(10_000).default(100),
          })
          .prefault({}),
      })
      .prefault({}),

    prompt: z
      .object({
        maxItems: z.number().int().min(1).max(20).default(5),
        maxTokens: z.number().int().min(32).max(4_000).default(600),
        order: z.number().int().min(-10_000).max(10_000).default(9_000),
      })
      .prefault({}),

    /**
     * First-turn retrieval budget. The prefetch starts when the agent claims
     * the user message (`agent/inbox/claimed`, which the loop emits before
     * `systemPrompt.assemble`), and the assembly waterfall awaits at most
     * `timeoutMs` of the remaining budget. Stable per turn: 300 tokens,
     * 8 items, 900-character query, 1500 ms, one bounded retry.
     */
    prefetch: z
      .object({
        enabled: z.boolean().default(true),
        maxTokens: z.number().int().min(32).max(4_000).default(300),
        maxItems: z.number().int().min(1).max(20).default(8),
        maxQueryChars: z.number().int().min(1).max(20_000).default(900),
        timeoutMs: z.number().int().min(50).max(30_000).default(1_500),
        maxRetries: z.number().int().min(0).max(2).default(1),
      })
      .prefault({}),

    /**
     * Milestone 6 retrieval coordinator. Two layers share one hard budget:
     * stable principal/project context first (`stableTokens`, refreshed once
     * per turn and reused across steps), then query-specific hits
     * (`queryTokens`) for the real first user message. `maxItems` and the
     * combined token cap apply to the merged block; `budgetMs` bounds the whole
     * retrieval, not each backend call.
     */
    retrieval: z
      .object({
        stableTokens: z.number().int().min(32).max(2_000).default(300),
        queryTokens: z.number().int().min(32).max(4_000).default(900),
        maxItems: z.number().int().min(1).max(20).default(8),
        budgetMs: z.number().int().min(50).max(30_000).default(1_500),
        /** Stable layer refresh cadence; query layer always follows the turn. */
        stableRefreshMs: z.number().int().min(1_000).max(3_600_000).default(300_000),
      })
      .prefault({}),

    /**
     * Milestone 4 authoritative task memory. Only verified lifecycle events and
     * records accepted by a named authority reach this path; model prose never
     * does. `scope` is the namespace task records are written to.
     */
    taskMemory: z
      .object({
        enabled: z.boolean().default(true),
        scope: z.enum(['agent', 'user', 'project', 'team']).default('project'),
        /** Cap on records kept per task, newest first. */
        maxRecordsPerTask: z.number().int().min(1).max(200).default(50),
      })
      .prefault({}),

    /**
     * Milestone 5 durable write outbox. Transient failures retry with
     * exponential backoff up to `maxAttempts`; permanent failures (authz,
     * validation, redaction) are terminal on the first attempt.
     */
    outbox: z
      .object({
        dir: nonEmpty.optional(),
        maxAttempts: z.number().int().min(1).max(10).default(3),
        baseBackoffMs: z.number().int().min(10).max(60_000).default(500),
        maxBackoffMs: z.number().int().min(100).max(600_000).default(30_000),
        /** A `processing` entry older than this is re-claimed after a crash. */
        leaseMs: z.number().int().min(1_000).max(3_600_000).default(60_000),
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

    /**
     * Settings page discoverability. `publicBaseUrl` is the browser-facing
     * origin of the web profile (e.g. the Traefik host); it is printed by
     * `memory_status` so the page is reachable without guessing. Empty means
     * "only the path is known" (headless or no reverse proxy).
     */
    settings: z
      .object({
        publicBaseUrl: z.string().trim().optional(),
      })
      .prefault({}),
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
