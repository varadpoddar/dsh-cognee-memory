/**
 * dsh-cognee-memory — persistent Cognee-backed memory for DeepSeek Harness.
 *
 * Phase 1 scaffold: verified DSH 0.2.1-rc.5 tool and prompt registrations,
 * transport-isolated Cognee adapters, deny-by-default scope policy, and
 * bounded untrusted prompt context.
 */
import type { PluginContextLike, ToolDefinitionLike } from './types.js'
import {
  CogneeMemoryConfigSchema,
  parseConfig,
  type CogneeMemoryConfig,
} from './config/schema.js'
import { createMemoryAdapter } from './adapters/memory-adapter.js'
import { MemoryCoordinator } from './memory/coordinator.js'
import { Metrics } from './telemetry/metrics.js'
import { registerAgentLifecycle } from './hooks/agent-lifecycle.js'
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
  const config = parseConfig(configInput)
  if (!config.enabled) return undefined

  const metrics = new Metrics()
  const adapter = createMemoryAdapter({ config, metrics, env: process.env })
  const coordinator = new MemoryCoordinator({ adapter, config, metrics })

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
