/**
 * dsh-cognee-memory — persistent Cognee-backed memory for DeepSeek Harness.
 *
 * Verified DSH 0.2.1-rc.5 tool and prompt registrations, transport-isolated
 * Cognee adapters, a deny-by-default scope policy, a bounded `Known context:`
 * injection, and an authenticated provenance view (host routes + browser
 * side-panel tab) for every recalled memory.
 */
import type { PluginContextLike, ToolDefinitionLike, WebServerLike } from './types.js'
import {
  CogneeMemoryConfigSchema,
  parseConfig,
  type CogneeMemoryConfig,
} from './config/schema.js'
import { createMemoryAdapter } from './adapters/memory-adapter.js'
import { MemoryLedger, resolveLedgerPath } from './memory/ledger.js'
import { MemoryCoordinator } from './memory/coordinator.js'
import { Metrics } from './telemetry/metrics.js'
import { registerAgentLifecycle } from './hooks/agent-lifecycle.js'
import { registerSessionExtraction } from './hooks/session-events.js'
import { MEMORY_POLICY_SECTION } from './hooks/prompt-context.js'
import { TaskLifecycleRecorder, registerTaskMemory } from './hooks/task-lifecycle.js'
import { ExtractionService } from './memory/extraction-service.js'
import { RecallVerificationLedger } from './memory/recall-verification.js'
import { buildInspection } from './settings/inspect.js'
import { ProvenanceIndex, resolveProvenancePath, type ProvenanceAccess } from './memory/provenance-index.js'
import { registerProvenanceRoutes } from './settings/provenance-http.js'
import { SettingsStore, resolveSettingsPath } from './settings/store.js'
import { buildSettingsUrl } from './settings/url.js'
import { registerSettingsRoutes } from './settings/http.js'
import { createRecallTool } from './tools/recall.js'
import { createRememberTool } from './tools/remember.js'
import { createForgetTool } from './tools/forget.js'
import { createStatusTool } from './tools/status.js'
import { createCogneeServiceRegistration } from './service/cognee.js'
import type { Context } from '@deepseek-ai/cordis'

/** Cordis plugin name. */
export const name = 'cognee-memory'

/**
 * Services this plugin reads. `tools` and `systemPrompt` are verified service
 * names in DSH 0.2.1-rc.5; agent lifecycle events are listened to directly.
 */
export const inject = ['tools', 'systemPrompt'] as const

/**
 * Cordis validates this Standard Schema before `apply()` runs
 * (`resolveConfig` calls `Config["~standard"].validate`). zod 4 implements it.
 */
export const Config = CogneeMemoryConfigSchema

export type { CogneeMemoryConfig }
export { CogneeMemoryConfigSchema, parseConfig }
export { MemoryCoordinator } from './memory/coordinator.js'
export { SettingsStore, resolveSettingsPath, SETTINGS_ENV } from './settings/store.js'
export {
  registerSettingsRoutes,
  renderSettingsPage,
  SETTINGS_PAGE_PATH,
  SETTINGS_JSON_PATH,
} from './settings/http.js'
export { validateCogneeUrl } from './settings/url.js'
export { MemoryError, UnsupportedOperationError, RedactionBlockedError } from './errors.js'
export { MemoryPromptContext } from './hooks/prompt-context.js'
export { TaskLifecycleRecorder, registerTaskMemory } from './hooks/task-lifecycle.js'
export { ExtractionService } from './memory/extraction-service.js'
export { CandidateQueue } from './memory/candidate-queue.js'
export { Outbox } from './memory/outbox.js'
export { RetrievalCoordinator } from './memory/retrieval.js'
export { RecallVerificationLedger } from './memory/recall-verification.js'
export {
  ProvenanceIndex,
  resolveProvenancePath,
  isAddressableMemoryId,
  PROVENANCE_FILE_ENV,
  PROVENANCE_MAX_ENTRIES,
  type ProvenanceEntry,
  type ProvenanceAccess,
  type ProvenanceIngestState,
} from './memory/provenance-index.js'
export {
  registerProvenanceRoutes,
  provenanceView,
  deepLinkFor,
  PROVENANCE_PATH_PREFIX,
  MEMORIES_JSON_PATH,
  COGNEE_UI_BASE_URL_ENV,
  DEFAULT_COGNEE_UI_BASE_URL,
  type MemoryProvenanceView,
} from './settings/provenance-http.js'
export {
  buildInspection,
  MEMORY_INSPECTION_STATES,
  type SettingsInspection,
  type MemoryInspectionState,
} from './settings/inspect.js'
export { MEMORY_POLICY_SECTION } from './hooks/prompt-context.js'
export {
  extractDeterministicCandidates,
  extractWithLlm,
  assertPrivateEndpoint,
  semanticKeyFor,
} from './memory/extraction.js'
export { IdentityResolver, PRINCIPAL_ENV } from './memory/identity.js'
export { EphemeralSessionMemory } from './memory/ephemeral.js'
export { createMemoryAdapter } from './adapters/memory-adapter.js'
export {
  COGNEE_SERVICE_NAME,
  createCogneeService,
  createCogneeServiceRegistration,
} from './service/cognee.js'
export type { CogneeServiceApi, CogneeServiceStatus } from './service/cognee.js'

/**
 * Apply the plugin. Tool and prompt registrations are reversible; the returned
 * cleanup is also installed as one Cordis effect so unload/dispose releases
 * every listener, prompt context, and tool definition exactly once.
 */
export function apply(
  ctx: PluginContextLike,
  configInput?: unknown,
): (() => void) | undefined {
  const bootConfig = parseConfig(configInput)

  /**
   * Runtime settings: a persisted JSON file that outranks the environment, which
   * outranks this profile entry. Re-read when it changes on disk, so both the
   * settings page and a hand edit take effect on the next call.
   */
  const settings = new SettingsStore({
    filePath: resolveSettingsPath(process.env),
    baseConfig: bootConfig,
    env: process.env,
  })
  const config = settings.current()
  if (!config.enabled) return undefined

  const endpoint = (): string => settings.current().apiBaseUrl

  const metrics = new Metrics()
  const adapter = createMemoryAdapter({ config, metrics, env: process.env, endpoint })
  // Bounded, metadata-only provenance for the authenticated detail view. It
  // never holds a credential; a failure to read or write it never fails recall.
  const provenance = new ProvenanceIndex({
    filePath: resolveProvenancePath(process.env),
    logger: (message) => process.stderr.write(`dsh-cognee-memory: ${message}\n`),
  })
  // Portable-record ledger: mirrors accepted durable writes so export/import
  // bundles carry text, semantic keys, provenance, and timestamps. A ledger
  // failure never fails a write.
  const ledger = new MemoryLedger({ filePath: resolveLedgerPath(process.env) })
  const coordinator = new MemoryCoordinator({
    adapter,
    config,
    metrics,
    endpoint,
    provenanceIndex: provenance,
    ledger,
  })
  // Bounded, read-only record of ids a recall actually returned; feeds the
  // settings page's `recall-verified` state.
  const verification = new RecallVerificationLedger()

  const disposers: Array<() => unknown> = []
  let disposed = false

  // Shared, typed `ctx.cognee` service: a thin, authorization-preserving
  // surface over the same coordinator the tools and hooks use. Cordis owns the
  // service registration on this plugin's fiber; disposing the fiber removes it
  // with everything else below, so there is no separate manual disposer.
  void createCogneeServiceRegistration(ctx as unknown as Context, {
    coordinator,
    config,
    metrics,
  })

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    for (const disposer of disposers.reverse()) {
      try {
        disposer()
      } catch {
        // A failing disposer must not prevent the remaining registrations from unwinding.
      }
    }
    disposers.length = 0
  }

  // The data-not-instructions property is system text, registered once. The
  // per-turn memory block stays compact and carries no warning preamble.
  disposers.push(ctx.systemPrompt.section(MEMORY_POLICY_SECTION))

  disposers.push(
    registerAgentLifecycle(ctx, { coordinator, config, metrics, verification }),
  )

  // Authoritative task memory: verified host lifecycle settlements only.
  const taskRecorder = new TaskLifecycleRecorder({ coordinator, config, metrics })
  if (config.taskMemory.enabled) {
    disposers.push(
      registerTaskMemory(ctx, { recorder: taskRecorder, coordinator, config, metrics }),
    )
  }

  // Automatic extraction runs independently of tools. It watches the
  // post-commit session feed, so `tools.enabled: false` changes nothing here.
  const extraction = new ExtractionService({ coordinator, config, metrics })
  disposers.push(
    registerSessionExtraction(ctx, {
      extraction,
      metrics,
      settleMs: config.extraction.llm.settleMs,
    }),
  )
  void extraction.start().catch(() => metrics.increment('extraction.failed'))

  // Present only where the profile mounts dsh-host-webserver (the shipped `web`
  // profile does; `headless` does not). Tools and prompt context still apply.
  // Routes are mounted through a nested `ctx.inject`, the idiom DSH's own
  // packages use: the callback runs only once `webServer` is available, so a
  // profile without a web server never reads an un-injected service (Cordis
  // throws on such property reads). Plain test doubles that already expose
  // `webServer` but no `inject` take the direct branch.
  const inspect = (): ReturnType<typeof buildInspection> =>
    buildInspection({
      store: settings,
      metrics,
      coordinator,
      identity: {},
      defaultWriteScope: config.scopes.defaultWriteScope,
      extraction,
      ...(adapter.inventory === undefined
        ? {}
        : { inventory: () => adapter.inventory?.() ?? Promise.resolve(undefined) }),
      verification,
    })

  // The detail route authorizes exactly like recall: the operator identity and
  // its readable scopes come from the same coordinator policy. A failure to
  // resolve them yields no readable scopes, so the route answers 404.
  const provenanceAccess = async (): Promise<ProvenanceAccess> => {
    const identity = await coordinator.resolveIdentity({})
    const policy = await coordinator.policyFor({})
    return {
      ...(identity.principalId === undefined ? {} : { principalId: identity.principalId }),
      readableScopes: policy.readableScopes,
    }
  }

  const mountWebRoutes = (webServer: WebServerLike): void => {
    for (const disposeRoutes of registerSettingsRoutes(webServer, { store: settings, inspect })) {
      disposers.push(disposeRoutes)
    }
    for (const disposeRoutes of registerProvenanceRoutes(webServer, {
      index: provenance,
      store: settings,
      access: provenanceAccess,
      ...(adapter.inventory === undefined && adapter.lookupDataset === undefined
        ? {}
        : {
            resolveDatasetId: async (datasetName: string): Promise<string | undefined> => {
              if (adapter.lookupDataset !== undefined) {
                const found = await adapter.lookupDataset(datasetName)
                if (found !== undefined) return found.id
              }
              const inventory = await adapter.inventory?.()
              return inventory?.datasets.find((dataset) => dataset.name === datasetName)?.id
            },
          }),
    })) {
      disposers.push(disposeRoutes)
    }
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      if (disposed) return
      mountWebRoutes(webCtx.webServer as WebServerLike)
    })
  } else {
    let webServer: WebServerLike | undefined
    try {
      webServer = ctx.webServer
    } catch {
      webServer = undefined
    }
    if (webServer !== undefined) mountWebRoutes(webServer)
  }

  if (config.tools.enabled) {
    // The settings page URL includes a literal token placeholder: `memory_status`
    // is model-visible, so the real token is never interpolated. It lives in
    // COGNEE_MEMORY_SETTINGS_TOKEN (deployment: /etc/dsh/cognee.env).
    const settingsLocation = buildSettingsUrl(
      settings.current().settings.publicBaseUrl,
      process.env,
    )
    const tools: ToolDefinitionLike[] = [
      createRecallTool({ coordinator, config, metrics }),
      createRememberTool({ coordinator, config, metrics }),
      createForgetTool({ coordinator, config, metrics }),
      createStatusTool({ coordinator, config, metrics, extraction, settings: settingsLocation }),
    ]
    for (const definition of tools) {
      disposers.push(ctx.tools.register(definition))
    }
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => dispose)
  }
  return dispose
}

export default { name, inject, Config, apply }
