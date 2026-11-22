/**
 * dsh-cognee-memory — persistent Cognee-backed memory for DeepSeek Harness.
 *
 * Phase 1 scaffold: verified DSH 0.2.1-rc.5 tool and prompt registrations,
 * transport-isolated Cognee adapters, deny-by-default scope policy, and
 * bounded untrusted prompt context.
 */
import type { PluginContextLike, ToolDefinitionLike, WebServerLike } from './types.js'
import {
  CogneeMemoryConfigSchema,
  parseConfig,
  type CogneeMemoryConfig,
} from './config/schema.js'
import { createMemoryAdapter } from './adapters/memory-adapter.js'
import { MemoryCoordinator } from './memory/coordinator.js'
import { Metrics } from './telemetry/metrics.js'
import { registerAgentLifecycle } from './hooks/agent-lifecycle.js'
import { SettingsStore, resolveSettingsPath } from './settings/store.js'
import { registerSettingsRoutes } from './settings/http.js'
import { createRecallTool } from './tools/recall.js'
import { createRememberTool } from './tools/remember.js'
import { createForgetTool } from './tools/forget.js'
import { createStatusTool } from './tools/status.js'

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
export { TaskLifecycleRecorder } from './hooks/task-lifecycle.js'
export { createMemoryAdapter } from './adapters/memory-adapter.js'

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
  const coordinator = new MemoryCoordinator({ adapter, config, metrics, endpoint })

  const disposers: Array<() => unknown> = []
  let disposed = false

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

  disposers.push(registerAgentLifecycle(ctx, { coordinator, config, metrics }))

  // Present only where the profile mounts dsh-host-webserver (the shipped `web`
  // profile does; `headless` does not). Tools and prompt context still apply.
  // Routes are mounted through a nested `ctx.inject`, the idiom DSH's own
  // packages use: the callback runs only once `webServer` is available, so a
  // profile without a web server never reads an un-injected service (Cordis
  // throws on such property reads). Plain test doubles that already expose
  // `webServer` but no `inject` take the direct branch.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      if (disposed) return
      for (const disposeRoutes of registerSettingsRoutes(webCtx.webServer as WebServerLike, {
        store: settings,
      })) {
        disposers.push(disposeRoutes)
      }
    })
  } else {
    let webServer: WebServerLike | undefined
    try {
      webServer = ctx.webServer
    } catch {
      webServer = undefined
    }
    if (webServer !== undefined) {
      for (const disposeRoutes of registerSettingsRoutes(webServer, { store: settings })) {
        disposers.push(disposeRoutes)
      }
    }
  }

  if (config.tools.enabled) {
    const tools: ToolDefinitionLike[] = [
      createRecallTool({ coordinator, config, metrics }),
      createRememberTool({ coordinator, config, metrics }),
      createForgetTool({ coordinator, config, metrics }),
      createStatusTool({ coordinator, config, metrics }),
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
