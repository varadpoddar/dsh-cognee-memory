import type {
  PluginContextLike,
  PromptContextRegistration,
  PromptSectionRegistration,
  ToolDefinitionLike,
} from '../../src/types.js'

export interface FakePromptRegistration {
  readonly registration: PromptContextRegistration | PromptSectionRegistration
  readonly dispose: () => void
  disposed: boolean
}

export interface FakePluginContext {
  readonly ctx: PluginContextLike
  readonly tools: ToolDefinitionLike[]
  readonly contexts: FakePromptRegistration[]
  readonly sections: FakePromptRegistration[]
  readonly listeners: Array<{ name: string; listener: (...args: never[]) => unknown; disposed: boolean }>
  readonly effects: Array<() => void>
  disposeAll(): void
}

/** Minimal structural Cordis context used by plugin integration tests. */
export function createFakePluginContext(): FakePluginContext {
  const tools: ToolDefinitionLike[] = []
  const contexts: FakePromptRegistration[] = []
  const sections: FakePromptRegistration[] = []
  const listeners: FakePluginContext['listeners'] = []
  const effects: Array<() => void> = []

  const makePromptRegistration = (
    registration: PromptContextRegistration | PromptSectionRegistration,
  ): FakePromptRegistration => ({
    registration,
    disposed: false,
    dispose() {
      this.disposed = true
    },
  })

  const ctx: PluginContextLike = {
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {
          const index = tools.indexOf(definition)
          if (index >= 0) tools.splice(index, 1)
        }
      },
    },
    systemPrompt: {
      context(registration) {
        const entry = makePromptRegistration(registration)
        contexts.push(entry)
        return () => entry.dispose()
      },
      section(registration) {
        const entry = makePromptRegistration(registration)
        sections.push(entry)
        return () => entry.dispose()
      },
    },
    on(name, listener) {
      const entry = { name, listener, disposed: false }
      listeners.push(entry)
      return () => {
        entry.disposed = true
        const index = listeners.indexOf(entry)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    effect(execute) {
      const cleanup = execute()
      if (typeof cleanup === 'function') effects.push(cleanup)
      return () => {
        cleanup?.()
      }
    },
    logger: () => ({
      debug() {},
      info() {},
      warn() {},
      error() {},
    }),
  }

  return {
    ctx,
    tools,
    contexts,
    sections,
    listeners,
    effects,
    disposeAll() {
      for (const effect of effects.splice(0)) effect()
      for (const entry of listeners.splice(0)) entry.listener = () => undefined
      for (const entry of contexts) entry.dispose()
      for (const entry of sections) entry.dispose()
      tools.length = 0
    },
  }
}
