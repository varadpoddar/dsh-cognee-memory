import type { CogneeMemoryConfig } from '../config/schema.js'
import type { RecallService } from '../memory/recall.js'
import { identityFromAgent } from '../memory/scopes.js'
import type { Metrics } from '../telemetry/metrics.js'
import type { AgentLike, PluginContextLike, RecallHit } from '../types.js'
import {
  MemoryPromptContext,
  applyMemoryContext,
  sanitizeQuery,
  type AssemblyContextLike,
  type PromptAssemblyLike,
} from './prompt-context.js'

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

/**
 * Emitted by the loop's inbox `claim()` — synchronously, before
 * `systemPrompt.assemble()` runs for the same step. This is the earliest point
 * where the turn's user text is known, so the prefetch starts here.
 */
interface InboxClaimedPayload {
  readonly agent: AgentWithContext
  readonly message: unknown
  readonly turn: number
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

/** True for a message the loop synthesized (runtime context), not user input. */
function isRuntimeContext(message: unknown): boolean {
  if (message === null || typeof message !== 'object') return false
  const source = (message as { source?: { kind?: unknown } }).source
  return source !== undefined && source.kind === 'runtime-context'
}

/**
 * Wire the agent lifecycle hooks verified in DSH 0.2.1-rc.5:
 * `agent/created`, `system-prompt/assemble`, `agent/inbox/claimed`,
 * `agent/pre-step`, and `agent/disposed`.
 *
 * Ordering is the whole point. The loop runs
 * `inbox.claim()` → `systemPrompt.assemble()` → `agent/pre-step`
 * (dsh-agent-loop/lib/index.js:906-909), and `claim()` emits
 * `agent/inbox/claimed` before assemble starts. The prefetch therefore begins
 * with the claimed user message, and the async `system-prompt/assemble`
 * waterfall — awaited before the request is built — waits inside the hard
 * budget and substitutes the fetched block. A one-shot turn now carries turn-1
 * memory in its first model call instead of the next step.
 */
export function registerAgentLifecycle(
  ctx: PluginContextLike,
  deps: {
    readonly coordinator: { readonly recallService: Pick<RecallService, 'safeRecall'> }
    readonly config: CogneeMemoryConfig
    readonly metrics?: Metrics
    readonly verification?: { record(hits: readonly RecallHit[]): void }
  },
): () => void {
  const bindings = new Map<string, AgentBinding>()
  const disposers: Array<() => unknown> = []
  let disposed = false

  const bindingFor = (agent: unknown): AgentBinding | undefined => {
    const identity = identityFromAgent(agent as AgentLike | undefined)
    return identity.sessionId === undefined ? undefined : bindings.get(identity.sessionId)
  }

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
        ...(deps.verification === undefined ? {} : { verification: deps.verification }),
      })
      const dispose = controller.register({ systemPrompt: promptContext })
      bindings.set(sessionId, { controller, dispose })
    } catch {
      // Registration failure must never veto agent creation.
      deps.metrics?.increment('prompt.failures')
    }
    return undefined
  }

  /** Start the bounded prefetch for the message this step just claimed. */
  const onClaimed = (payload: InboxClaimedPayload): undefined => {
    try {
      if (isRuntimeContext(payload.message)) return undefined
      const query = sanitizeQuery(textFromMessage(payload.message))
      if (query === '') return undefined
      bindingFor(payload.agent)?.controller.beginPrefetch({ turn: payload.turn, query })
    } catch {
      deps.metrics?.increment('prefetch.failures')
    }
    return undefined
  }

  /**
   * Expert waterfall over the assembled prompt (dsh-system-prompt), awaited by
   * the loop before it builds the model request. The default assembly already
   * resolved this plugin's context provider to its (possibly empty) cache, so
   * the entry is rewritten with the awaited block.
   */
  const onAssemble = async (
    assembly: PromptAssemblyLike,
    context: AssemblyContextLike,
    next: () => Promise<PromptAssemblyLike>,
  ): Promise<PromptAssemblyLike> => {
    const resolved = await next()
    try {
      const binding = bindingFor(context?.agent)
      if (binding === undefined) return resolved
      const block = await binding.controller.resolveForAssembly(context ?? {})
      return block === '' ? resolved : applyMemoryContext(resolved, block)
    } catch {
      // Prompt assembly must never fail because memory was unavailable.
      deps.metrics?.increment('prefetch.failures')
      return resolved
    }
  }

  const onPreStep = async (
    payload: PreStepPayload,
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> => {
    try {
      const binding = bindingFor(payload.agent)
      if (binding !== undefined) {
        binding.controller.noteTurn(payload.turn)
        // Fallback for hosts that never emit `agent/inbox/claimed`: the fetch
        // started here is still deduplicated and reused by the next assembly.
        const query = lastUserText(payload.messages)
        if (query !== '') binding.controller.beginPrefetch({ turn: payload.turn, query })
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
      binding.controller.clear()
      binding.dispose()
    } catch {
      // Disposal is best-effort; the agent scope also unwinds registrations.
    }
  }

  disposers.push(ctx.on('agent/created', onCreated as never))
  disposers.push(ctx.on('system-prompt/assemble', onAssemble as never))
  disposers.push(ctx.on('agent/inbox/claimed', onClaimed as never))
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
        binding.controller.clear()
        binding.dispose()
      } catch {
        // The agent scope owns final disposal.
      }
    }
    bindings.clear()
  }
}
