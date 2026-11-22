import { describe, expect, it } from 'vitest'
import { makeScopeRef, scopeIdFor } from '../src/memory/scopes.js'
import { createRecallTool } from '../src/tools/recall.js'
import { createRememberTool } from '../src/tools/remember.js'
import { createForgetTool } from '../src/tools/forget.js'
import { PROJECT_SCOPE, createHarness, record } from './helpers/fake-coordinator.js'
import { checkLosslessJson, survivesJsonRoundTrip } from './helpers/lossless-json.js'

function exec() {
  return { signal: new AbortController().signal, agent: { session: { id: 'session-1' } } }
}

/** A project scope whose id is lossy enough to carry the non-enumerable legacyName. */
const LOSSY_SCOPE = makeScopeRef('project', '/workspace/Demo Project')

describe('tool output is lossless JSON (DSH output contract)', () => {
  it('the fixture really does carry a non-enumerable own key', () => {
    // Guards the regression test itself: if ScopeRef stopped hiding legacyName,
    // the recall assertion below would stop proving anything.
    const keys = Reflect.ownKeys(LOSSY_SCOPE)
    expect(keys).toContain('legacyName')
    const descriptor = Object.getOwnPropertyDescriptor(LOSSY_SCOPE, 'legacyName')
    expect(descriptor?.enumerable).toBe(false)
    expect(checkLosslessJson({ scope: LOSSY_SCOPE }).ok).toBe(false)
  })

  it('memory_recall never returns a raw ScopeRef', async () => {
    const harness = createHarness(
      {
        async recall() {
          return [record('mem-1', 'release codename is amber-otter-7731', LOSSY_SCOPE)]
        },
      },
      { scopeDefaults: { projectId: '/workspace/Demo Project' } },
    )
    const tool = createRecallTool({ coordinator: harness.coordinator, config: harness.config })
    const value = await tool.execute({ query: 'codename' }, exec())

    const lossless = checkLosslessJson(value)
    expect(lossless).toEqual({ ok: true })
    expect(survivesJsonRoundTrip(value)).toBe(true)
    expect((value as { memories: Array<{ scope: unknown }> }).memories[0]?.scope).toEqual({
      scope: 'project',
      id: scopeIdFor('project', '/workspace/Demo Project'),
    })
    expect(Object.keys((value as { memories: Array<{ scope: object }> }).memories[0]!.scope)).toEqual([
      'scope',
      'id',
    ])
  })

  it('memory_recall keeps project scope lossless too', async () => {
    const harness = createHarness({
      async recall() {
        return [record('mem-1', 'alpha', PROJECT_SCOPE)]
      },
    })
    const tool = createRecallTool({ coordinator: harness.coordinator, config: harness.config })
    const value = await tool.execute({ query: 'alpha' }, exec())
    expect(checkLosslessJson(value)).toEqual({ ok: true })
    expect(survivesJsonRoundTrip(value)).toBe(true)
  })

  it('memory_remember returns a lossless scope value', async () => {
    const harness = createHarness({
      async remember(input) {
        return { id: 'mem-9', scope: LOSSY_SCOPE, createdAt: '2026-01-01T00:00:00.000Z', deduplicated: false }
      },
    })
    const tool = createRememberTool({ coordinator: harness.coordinator, config: harness.config })
    const value = await tool.execute({ text: 'durable fact' }, exec())
    expect(checkLosslessJson(value)).toEqual({ ok: true })
    expect(survivesJsonRoundTrip(value)).toBe(true)
    expect((value as { scope: { id: string } }).scope.id).toBe(
      scopeIdFor('project', '/workspace/Demo Project'),
    )
  })

  it('memory_forget returns a lossless scope value', async () => {
    const harness = createHarness({
      async forget() {
        return { id: 'mem-9', scope: LOSSY_SCOPE, forgotten: true }
      },
    })
    const tool = createForgetTool({ coordinator: harness.coordinator, config: harness.config })
    const value = await tool.execute({ id: 'mem-9' }, exec())
    expect(checkLosslessJson(value)).toEqual({ ok: true })
    expect(survivesJsonRoundTrip(value)).toBe(true)
  })
})
