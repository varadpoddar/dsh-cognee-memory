import type { IncomingMessage, ServerResponse } from 'node:http'

/** Lossless JSON value used at adapter and tool boundaries. */
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue }

/** The six memory scopes, narrowest first; global is opt-in only. */
export const MEMORY_SCOPES = ['session', 'agent', 'user', 'project', 'team', 'global'] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

/** One stable, backend-safe scope identity. `id` never contains the raw session id. */
export interface ScopeRef {
  readonly scope: MemoryScope
  /** Deterministic namespace segment; never a DSH session id for durable scopes. */
  readonly id: string
  /** M1 dataset name kept for read-only compatibility; never used for new writes. */
  readonly legacyName?: string
}

/** Where a memory came from. Only authoritative evidence kinds are accepted for writes. */
export type ProvenanceKind = 'user_explicit' | 'tool_call' | 'task_outcome' | 'session_event' | 'import'

export interface Provenance {
  readonly kind: ProvenanceKind
  /** Producer that observed the evidence (tool name, hook name, importer). */
  readonly source: string
  readonly recordedAt: string
  readonly sessionId?: string
  readonly agentId?: string
  readonly taskId?: string
  readonly turn?: number
  readonly step?: number
  /** Stable pointer to the authoritative record, never free-form model prose. */
  readonly evidence?: string
}

export interface MemoryRecord {
  readonly id: string
  readonly text: string
  readonly scope: ScopeRef
  readonly createdAt: string
  readonly tags?: readonly string[]
  readonly provenance?: Provenance
  readonly metadata?: Readonly<Record<string, JsonValue>>
}

export interface RememberInput {
  readonly text: string
  readonly scope: ScopeRef
  readonly tags?: readonly string[]
  readonly provenance: Provenance
  readonly dedupeKey?: string
  readonly metadata?: Readonly<Record<string, JsonValue>>
  readonly signal?: AbortSignal
}

export interface RememberResult {
  readonly id: string
  readonly scope: ScopeRef
  readonly createdAt: string
  readonly deduplicated: boolean
}

export interface RecallQuery {
  readonly text: string
  readonly scopes: readonly ScopeRef[]
  readonly limit: number
  readonly minScore?: number
  readonly signal?: AbortSignal
}

export interface RecallHit {
  readonly record: MemoryRecord
  /** Backend relevance in [0, 1] when supplied, otherwise a deterministic local rank. */
  readonly score: number
}

export interface ForgetInput {
  readonly id: string
  readonly scope: ScopeRef
  readonly signal?: AbortSignal
}

export interface ForgetResult {
  readonly id: string
  readonly scope: ScopeRef
  readonly forgotten: boolean
}

export interface HealthResult {
  readonly ok: boolean
  readonly latencyMs?: number
  readonly message?: string
}

export interface AdapterStatus {
  readonly transport: ResolvedTransport
  readonly reachable: boolean
  readonly checkedAt: string
  readonly details?: Readonly<Record<string, JsonValue>>
}

/**
 * One durable dataset the authenticated principal can see for a scope.
 * Read-only inventory used by the settings page (`Memory 9`); it never carries
 * memory text, only counts and identifiers.
 */
export interface MemoryDatasetInventory {
  readonly id: string
  /** Durable namespace key, e.g. `dsh-project-project-4be96e7c2cdbb95a1ac9`. */
  readonly name: string
  readonly scope?: ScopeRef
  /** Raw data records in this dataset, when the backend can count them. */
  readonly dataCount?: number
  readonly searchable?: boolean
  readonly state?: string
}

export interface MemoryInventory {
  readonly datasets: readonly MemoryDatasetInventory[]
  /** Total raw records across the visible datasets, when countable. */
  readonly totalRecords?: number
  readonly checkedAt: string
  readonly truncated?: boolean
}

export type TransportKind = 'mcp-http' | 'mcp-stdio' | 'rest' | 'auto'
export type ResolvedTransport = Exclude<TransportKind, 'auto'>

/**
 * Transport-neutral memory backend. All adapters must implement every method;
 * unsupported backend capabilities throw `UnsupportedOperationError` rather
 * than silently degrading to a destructive call.
 */
export interface MemoryAdapter {
  remember(input: RememberInput): Promise<RememberResult>
  recall(query: RecallQuery): Promise<readonly RecallHit[]>
  forget(input: ForgetInput): Promise<ForgetResult>
  status(signal?: AbortSignal): Promise<AdapterStatus>
  health(): Promise<HealthResult>
  /** Authenticated Cognee user behind the API key, when the transport can read it. */
  probePrincipal?(): Promise<string | undefined>
  /** Read-only dataset/record inventory for the settings page. */
  inventory?(signal?: AbortSignal): Promise<MemoryInventory>
  /**
   * Resolve one dataset by exact name. The detail view needs the backend UUID,
   * which only the backend assigns; `inventory` pages its answer, so this is a
   * separate, unbounded lookup.
   */
  lookupDataset?(name: string, signal?: AbortSignal): Promise<{ id: string; name: string } | undefined>
}

/** Caller identity available at a tool call or hook boundary. */
export interface CallerIdentity {
  readonly sessionId?: string
  /** Authenticated principal id from the deployment/Cognee identity, never model text. */
  readonly principalId?: string
  readonly agentId?: string
  /** Agent preset from the committed session header, never the session id. */
  readonly agentPreset?: string
  readonly projectId?: string
  readonly teamId?: string
}

/** Structural view of a DSH agent; avoids a hard import of the host package. */
export interface AgentLike {
  readonly session?: {
    readonly id?: unknown
    readonly header?: { readonly agentPreset?: unknown }
  }
}

/** Minimal model-facing content block accepted by DSH tool renderers. */
export interface TextContentBlock {
  readonly type: 'text'
  readonly text: string
}

/** Structural run context handed to a DSH tool body. */
export interface ToolRunContextLike {
  readonly signal: AbortSignal
  readonly agent?: AgentLike
}

/** Structural definition accepted by `ctx.tools.register()` in DSH 0.2.1-rc.5. */
export interface ToolDefinitionLike {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
  readonly output: {
    readonly schema: Readonly<Record<string, unknown>>
    readonly render: (args: unknown, value: unknown) => readonly TextContentBlock[]
  }
  readonly timeoutMs?: number
  readonly execute: (args: unknown, exec: ToolRunContextLike) => Promise<unknown>
}

export interface PromptContextRegistration {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: unknown) => string)
  readonly interpolate?: boolean
  readonly required?: boolean
}

export interface PromptSectionRegistration {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: unknown) => string)
  readonly interpolate?: boolean
  readonly complete?: boolean
}

export interface PluginLoggerLike {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/**
 * Structural subset of the Cordis context this plugin uses. The real host
 * context satisfies it structurally, which keeps the package buildable
 * without vendoring DSH's type packages.
 */
export interface PluginContextLike {
  readonly tools: {
    register(definition: ToolDefinitionLike): () => void
  }
  readonly systemPrompt: {
    context(registration: PromptContextRegistration): () => void
    section(registration: PromptSectionRegistration): () => void
  }
  /**
   * Present only in composed profiles that mount `dsh-host-webserver` (the
   * shipped `web` profile does; `headless` does not). Optional so the plugin
   * still applies with tools and prompt context when no web server exists.
   */
  readonly webServer?: WebServerLike
  /**
   * Cordis's inject-free service lookup (`ctx.get(name)`). Reading an
   * un-injected service through the context proxy throws, so optional services
   * must be resolved through this method instead of property access.
   */
  get?(name: string): unknown
  /**
   * Cordis's nested dependency activation (`ctx.inject(deps, callback)`). The
   * callback runs only while every named service is available, which is how an
   * optional service is consumed without making the whole plugin depend on it.
   */
  inject?(deps: readonly string[], callback: (ctx: PluginContextLike) => void): unknown
  /**
   * Cordis's fiber-owned service registration (`ctx.provide(name, value)`).
   * The service is unregistered when the returned disposer runs or the
   * providing fiber unloads. Optional so structural test doubles still apply;
   * `registerCogneeService` degrades to a no-op when it is absent.
   */
  provide?(name: string, value: unknown): (() => void) | void
  on(name: string, listener: (...args: never[]) => unknown): () => unknown
  effect?(execute: () => (() => void) | void): () => unknown
  logger?(name: string): PluginLoggerLike
}

/** One route registration accepted by `ctx.webServer.register` (verified shape). */
export interface WebRouteLike {
  readonly kind: 'exact' | 'prefix'
  /** Absolute pathname, no trailing slash. */
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** Structural subset of `dsh-host-webserver`'s `WebServer` service. */
export interface WebServerLike {
  register(route: WebRouteLike): () => void
}

