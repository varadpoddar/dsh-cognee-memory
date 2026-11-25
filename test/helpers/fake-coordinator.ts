import { parseConfig, type CogneeMemoryConfig } from '../../src/config/schema.js'
import { MemoryCoordinator } from '../../src/memory/coordinator.js'
import { makeScopeRef } from '../../src/memory/scopes.js'
import { Metrics } from '../../src/telemetry/metrics.js'
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
} from '../../src/types.js'

export const PROJECT_ID = '/workspace/demo'
export const PROJECT_SCOPE = makeScopeRef('project', PROJECT_ID)
export const SESSION_SCOPE = makeScopeRef('session', 'session-1')
export const FIXED_NOW = '2026-01-01T00:00:00.000Z'

export interface FakeAdapterCalls {
  readonly remember: RememberInput[]
  readonly batch: RememberInput[][]
  readonly recall: RecallQuery[]
  readonly forget: ForgetInput[]
  status: number
  health: number
}

export interface TestHarness {
  readonly config: CogneeMemoryConfig
  readonly adapter: MemoryAdapter
  readonly calls: FakeAdapterCalls
  readonly metrics: Metrics
  readonly coordinator: MemoryCoordinator
}

export function record(id: string, text: string, scope = PROJECT_SCOPE): RecallHit {
  return {
    record: { id, text, scope, createdAt: FIXED_NOW },
    score: 0.9,
  }
}

export function createHarness(
  overrides: Partial<MemoryAdapter> = {},
  configOverrides: Record<string, unknown> = {},
): TestHarness {
  const config = parseConfig({
    transport: 'rest',
    apiBaseUrl: 'http://127.0.0.1:9',
    authMode: 'none',
    requestTimeoutMs: 1_000,
    maxRetries: 0,
    retryBackoffMs: 0,
    scopeDefaults: { projectId: PROJECT_ID },
    ...configOverrides,
  })
  const calls: FakeAdapterCalls = { remember: [], batch: [], recall: [], forget: [], status: 0, health: 0 }
  const defaults: MemoryAdapter = {
    async remember(input: RememberInput): Promise<RememberResult> {
      return { id: 'mem-1', scope: input.scope, createdAt: FIXED_NOW, deduplicated: false }
    },
    async recall(_query: RecallQuery): Promise<readonly RecallHit[]> {
      return []
    },
    async forget(input: ForgetInput): Promise<ForgetResult> {
      return { id: input.id, scope: input.scope, forgotten: true }
    },
    async status(): Promise<AdapterStatus> {
      return { transport: 'rest', reachable: true, checkedAt: FIXED_NOW, details: { datasetCount: 1 } }
    },
    async health(): Promise<HealthResult> {
      return { ok: true, latencyMs: 1 }
    },
  }
  const adapter: MemoryAdapter = {
    remember: async (input) => {
      calls.remember.push(input)
      return overrides.remember === undefined ? defaults.remember(input) : overrides.remember(input)
    },
    recall: async (query) => {
      calls.recall.push(query)
      return overrides.recall === undefined ? defaults.recall(query) : overrides.recall(query)
    },
    forget: async (input) => {
      calls.forget.push(input)
      return overrides.forget === undefined ? defaults.forget(input) : overrides.forget(input)
    },
    status: async () => {
      calls.status += 1
      return overrides.status === undefined ? defaults.status() : overrides.status()
    },
    health: async () => {
      calls.health += 1
      return overrides.health === undefined ? defaults.health() : overrides.health()
    },
    ...(overrides.rememberBatch === undefined
      ? {}
      : {
          rememberBatch: async (inputs: readonly RememberInput[]) => {
            calls.batch.push([...inputs])
            return overrides.rememberBatch!(inputs)
          },
        }),
  }
  const metrics = new Metrics(() => new Date(FIXED_NOW))
  const coordinator = new MemoryCoordinator({
    adapter,
    config,
    metrics,
    cwd: PROJECT_ID,
    clock: () => new Date(FIXED_NOW),
  })
  return { config, adapter, calls, metrics, coordinator }
}

export function identity(): { sessionId: string; agentId: string; projectId: string } {
  return { sessionId: 'session-1', agentId: 'session-1', projectId: PROJECT_ID }
}
