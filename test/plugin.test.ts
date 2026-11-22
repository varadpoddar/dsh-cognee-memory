import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '@deepseek-ai/cordis'
import { apply, Config, name, inject } from '../src/index.js'
import { parseConfig } from '../src/config/schema.js'
import type { JsonValue } from '../src/types.js'
import { createFakePluginContext } from './helpers/fake-context.js'

const SUPPORTED_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
])

function schemaViolations(schema: JsonValue, path = 'schema'): string[] {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return [`${path} must be an object`]
  }
  const node = schema as Record<string, JsonValue>
  const violations: string[] = []
  for (const key of Object.keys(node)) {
    if (!SUPPORTED_KEYWORDS.has(key)) violations.push(`${path}.${key} is not supported`)
  }
  const type = node.type
  if (typeof type === 'string') {
    if (type === 'object') {
      const properties = node.properties
      if (properties !== undefined && properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
        for (const [key, child] of Object.entries(properties as Record<string, JsonValue>)) {
          violations.push(...schemaViolations(child, `${path}.properties.${key}`))
        }
      }
      if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') {
        violations.push(`${path}.additionalProperties must be boolean`)
      }
    } else if (type === 'array' && node.items !== undefined) {
      violations.push(...schemaViolations(node.items, `${path}.items`))
    }
  } else if (type !== undefined) {
    violations.push(`${path}.type must be a string`)
  }
  const oneOf = node.oneOf
  if (Array.isArray(oneOf)) {
    oneOf.forEach((branch, index) => {
      violations.push(...schemaViolations(branch, `${path}.oneOf[${index}]`))
    })
  }
  return violations
}

describe('plugin entry', () => {
  it('exports the Cordis plugin contract', () => {
    expect(name).toBe('cognee-memory')
    expect(inject).toContain('tools')
    expect(inject).toContain('systemPrompt')
    expect(typeof Config['~standard'].validate).toBe('function')
  })

  it('is accepted by the installed Cordis resolveConfig()', () => {
    const runtime = { Config }
    const resolved = resolveConfig(runtime as never, { transport: 'rest', maxRetries: 0 }) as {
      maxRetries: number
      prompt: { maxTokens: number }
    }
    expect(resolved.maxRetries).toBe(0)
    expect(resolved.prompt.maxTokens).toBe(600)
  })

  it('validates config through the Standard Schema interface used by Cordis', () => {
    const result = Config['~standard'].validate({ transport: 'rest', maxRetries: 0 })
    expect(result).not.toBeInstanceOf(Promise)
    if ('value' in result) {
      expect(result.value.maxRetries).toBe(0)
      expect(result.value.transport).toBe('rest')
      expect(result.value.prompt.maxTokens).toBeGreaterThan(0)
    } else {
      throw new Error('expected validation success')
    }
  })

  it('does nothing when disabled', () => {
    const fake = createFakePluginContext()
    const result = apply(fake.ctx, { enabled: false })
    expect(result).toBeUndefined()
    expect(fake.tools).toHaveLength(0)
    expect(fake.listeners).toHaveLength(0)
    expect(fake.contexts).toHaveLength(0)
  })

  it('rejects invalid config without contacting any backend', () => {
    const fake = createFakePluginContext()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    expect(() => apply(fake.ctx, { transport: 'rest', apiBaseUrl: 'ftp://nowhere' })).toThrowError(
      /invalid cognee memory config/,
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(fake.tools).toHaveLength(0)
  })

  it('registers the four tools and agent lifecycle listeners without network activity', () => {
    const fake = createFakePluginContext()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const dispose = apply(fake.ctx, {
      transport: 'rest',
      apiBaseUrl: 'http://127.0.0.1:9',
      security: { redactionMode: 'reject' },
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(fake.tools.map((tool) => tool.name).sort()).toEqual([
      'memory_forget',
      'memory_recall',
      'memory_remember',
      'memory_status',
    ])
    expect(fake.listeners.map((entry) => entry.name).sort()).toEqual([
      'agent/created',
      'agent/disposed',
      'agent/inbox/claimed',
      'agent/pre-step',
      'agent/turn-stopping',
      'llm/stream',
      'session/disposed',
      'session/event',
      'subagent/end',
      'system-prompt/assemble',
      'workflow/agent-end',
    ])
    expect(fake.sections.map((entry) => entry.registration.name)).toEqual([
      'cognee:memory-policy',
    ])
    expect(typeof dispose).toBe('function')
  })

  it('keeps automatic extraction active when every memory tool is disabled', () => {
    const fake = createFakePluginContext()
    const dispose = apply(fake.ctx, {
      transport: 'rest',
      apiBaseUrl: 'http://127.0.0.1:9',
      tools: { enabled: false },
    })
    expect(fake.tools).toHaveLength(0)
    expect(fake.listeners.map((entry) => entry.name).sort()).toEqual([
      'agent/created',
      'agent/disposed',
      'agent/inbox/claimed',
      'agent/pre-step',
      'agent/turn-stopping',
      'llm/stream',
      'session/disposed',
      'session/event',
      'subagent/end',
      'system-prompt/assemble',
      'workflow/agent-end',
    ])
    expect(fake.sections.map((entry) => entry.registration.name)).toEqual([
      'cognee:memory-policy',
    ])
    expect(typeof dispose).toBe('function')
  })

  it('ships safe namespace and extraction defaults', () => {
    const config = parseConfig({})
    expect(config.scopes.allowGlobal).toBe(false)
    expect(config.scopes.defaultWriteScope).toBe('project')
    expect(config.extraction.enabled).toBe(true)
    expect(config.extraction.deterministic).toBe(true)
    expect(config.extraction.llm.enabled).toBe(false)
  })

  it('declares only the JSON Schema subset accepted by DSH 0.2.1-rc.5', () => {
    const fake = createFakePluginContext()
    apply(fake.ctx, { transport: 'rest', apiBaseUrl: 'http://127.0.0.1:9' })
    for (const tool of fake.tools) {
      expect(schemaViolations(tool.output.schema as unknown as JsonValue, `${tool.name}.output`)).toEqual([])
      expect(schemaViolations(tool.parameters as unknown as JsonValue, `${tool.name}.parameters`)).toEqual([])
    }
    expect(fake.tools).toHaveLength(4)
  })

  it('deregisters every tool and listener exactly once on dispose', () => {
    const fake = createFakePluginContext()
    const dispose = apply(fake.ctx, {
      transport: 'rest',
      apiBaseUrl: 'http://127.0.0.1:9',
    })
    expect(fake.tools).toHaveLength(4)
    dispose?.()
    expect(fake.tools).toHaveLength(0)
    expect(fake.listeners).toHaveLength(0)
    // The Cordis effect cleanup is idempotent with the returned disposer.
    fake.disposeAll()
    expect(fake.tools).toHaveLength(0)
    expect(fake.listeners).toHaveLength(0)
  })
})
