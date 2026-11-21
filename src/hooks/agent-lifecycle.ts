import type { CogneeMemoryConfig } from '../config/schema.js'
import type { RecallService } from '../memory/recall.js'
import { identityFromAgent } from '../memory/scopes.js'
import type { Metrics } from '../telemetry/metrics.js'
import type { AgentLike, PluginContextLike } from '../types.js'
import { MemoryPromptContext, sanitizeQuery } from './prompt-context.js'

interface AgentWithContext extends AgentLike {
  readonly ctx?: Pick<PluginContextLike, 'systemPrompt'>
}

interface AgentCreatedPayload {
  readonly agent: AgentWithContext
}

interface AgentDisposedPayload {
  readonly agent: AgentWithContext
}

interface PreStepPayload {
  readonly agent: AgentWithContext
  readonly messages: readonly unknown[]
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

type PreStepDecision = { readonly kind: 'reject' } | { readonly kind: 'enter'; readonly messages: readonly unknown[] }

interface AgentBinding {
  readonly controller: MemoryPromptContext
  readonly dispose: () => void
}

function textFromMessage(message: unknown): string {
  if (message === null || typeof message !== 'object') return ''
  const role = (message as { role?: unknown }).role
  if (role !== undefined && role !== 'user') return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (block === null || typeof block !== 'object') return ''
      const candidate = block as { type?: unknown; text?: unknown }
      return candidate.type === 'text' && typeof candidate.text === 'string' ? candidate.text : ''
    })
    .filter((part) => part !== '')
    .join('\n')
}

/** Last user text in the claimed pre-step batch; never assistant output. */
export function lastUserText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = sanitizeQuery(textFromMessage(messages[index]))
    if (text !== '') return text
  }
  return ''
}

/**
 * Wire only the agent lifecycle hooks verified in DSH 0.2.1-rc.5:
 * `agent/created`, `agent/pre-step`, and `agent/disposed`.
 *
 * Prompt context is registered per agent in `agent.ctx`, so memory from one
 * live session cannot appear in another agent's prompt. The pre-step refresh is
 * fire-and-forget; assembly has already happened for this step, so the fresh
 * block is visible from the next step and never delays or rejects the turn.
 */
export function registerAgentLifecycle(
  ctx: PluginContextLike,
  deps: {
    readonly coordinator: { readonly recallService: Pick<RecallService, 'safeRecall'> }
    readonly config: CogneeMemoryConfig
    readonly metrics?: Metrics
  },
): () => void {
  const bindings = new Map<string, AgentBinding>()
  const disposers: Array<() => unknown> = []
  let disposed = false

  const onCreated = (payload: AgentCreatedPayload): undefined => {
    try {
      const identity = identityFromAgent(payload.agent)
      const sessionId = identity.sessionId
      if (sessionId === undefined || sessionId === '' || bindings.has(sessionId)) return undefined
      const promptContext = payload.agent.ctx?.systemPrompt
      if (promptContext === undefined) return undefined
      const controller = new MemoryPromptContext({
        recall: deps.coordinator.recallService,
        config: deps.config,
        identity,
        ...(deps.metrics === undefined ? {} : { metrics: deps.metrics }),
      })
      const dispose = controller.register({ systemPrompt: promptContext })
      bindings.set(sessionId, { controller, dispose })
    } catch {
      // Registration failure must never veto agent creation.
      deps.metrics?.increment('prompt.failures')
    }
    return undefined
  }

  const onPreStep = async (
    payload: PreStepPayload,
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> => {
    try {
      const identity = identityFromAgent(payload.agent)
      const binding = identity.sessionId === undefined ? undefined : bindings.get(identity.sessionId)
      const query = lastUserText(payload.messages)
      if (binding !== undefined && query !== '') {
        void binding.controller
          .refresh({
            query,
            signal: payload.signal,
          })
          .catch(() => {
            deps.metrics?.increment('prompt.failures')
          })
      }
    } catch {
      deps.metrics?.increment('prompt.failures')
    }
    return next()
  }

  const onDisposed = (payload: AgentDisposedPayload): void => {
    try {
      const identity = identityFromAgent(payload.agent)
      if (identity.sessionId === undefined) return
      const binding = bindings.get(identity.sessionId)
      if (binding === undefined) return
      bindings.delete(identity.sessionId)
      binding.dispose()
    } catch {
      // Disposal is best-effort; the agent scope also unwinds registrations.
    }
  }

  disposers.push(ctx.on('agent/created', onCreated as never))
  disposers.push(ctx.on('agent/pre-step', onPreStep as never))
  disposers.push(ctx.on('agent/disposed', onDisposed as never))

  return () => {
    if (disposed) return
    disposed = true
    for (const disposer of disposers.splice(0).reverse()) {
      try {
        disposer()
      } catch {
        // Continue unwinding the remaining listeners.
      }
    }
    for (const binding of bindings.values()) {
      try {
        binding.dispose()
      } catch {
        // The agent scope owns final disposal.
      }
    }
    bindings.clear()
  }
}
