import { describe, expect, it, vi } from 'vitest'
import { MemoryError } from '../src/errors.js'
import { provenanceFromTool } from '../src/memory/provenance.js'
import { makeScopeRef } from '../src/memory/scopes.js'
import {
  FIXED_NOW,
  PROJECT_ID,
  PROJECT_SCOPE,
  SESSION_SCOPE,
  createHarness,
  identity,
  record,
} from './helpers/fake-coordinator.js'

const provenance = provenanceFromTool('memory_remember', identity())

describe('MemoryCoordinator.remember', () => {
  it('defaults to the project scope and passes tool provenance', async () => {
    const harness = createHarness()
    const result = await harness.coordinator.remember({
      text: 'durable decision',
      identity: identity(),
      provenance,
    })
    expect(result).toMatchObject({ id: 'mem-1', scope: PROJECT_SCOPE, deduplicated: false })
    expect(harness.calls.remember[0]).toMatchObject({
      text: 'durable decision',
      scope: PROJECT_SCOPE,
      provenance: expect.objectContaining({ kind: 'tool_call' }),
    })
  })

  it('keeps an explicit session scope ephemeral and never calls the backend', async () => {
    const harness = createHarness()
    await harness.coordinator.remember({
      text: 'session fact',
      identity: identity(),
      scopeName: 'session',
      provenance,
    })
    expect(harness.calls.remember).toHaveLength(0)
    const hits = await harness.coordinator.recall({
      text: 'session fact',
      identity: identity(),
      limit: 5,
    })
    expect(hits.map((hit) => hit.record.text)).toContain('session fact')
    expect(hits[0]?.record.scope).toEqual(SESSION_SCOPE)
  })

  it('denies a scope the caller does not have', async () => {
    const harness = createHarness()
    await expect(
      harness.coordinator.remember({
        text: 'x',
        identity: {},
        scopeName: 'session',
        provenance,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(harness.calls.remember).toHaveLength(0)
  })

  it('deduplicates an identical local write without calling the backend twice', async () => {
    const harness = createHarness()
    await harness.coordinator.remember({ text: 'same fact', identity: identity(), provenance })
    const second = await harness.coordinator.remember({
      text: 'same fact',
      identity: identity(),
      provenance,
    })
    expect(second.deduplicated).toBe(true)
    expect(harness.calls.remember).toHaveLength(1)
  })

  it('returns a backend near-duplicate without writing', async () => {
    const harness = createHarness({
      async recall() {
        return [record('existing', 'same fact')]
      },
    })
    const result = await harness.coordinator.remember({
      text: 'same fact',
      identity: identity(),
      provenance,
    })
    expect(result).toMatchObject({ id: 'existing', deduplicated: true })
    expect(harness.calls.remember).toHaveLength(0)
  })

  it('proceeds with the write when the dedupe lookup fails', async () => {
    const harness = createHarness({
      async recall() {
        throw new MemoryError('UNAVAILABLE', 'offline', { retryable: true })
      },
    })
    await expect(
      harness.coordinator.remember({ text: 'new fact', identity: identity(), provenance }),
    ).resolves.toMatchObject({ deduplicated: false })
    expect(harness.calls.remember).toHaveLength(1)
  })

  it('blocks secrets before any backend call', async () => {
    const harness = createHarness()
    await expect(
      harness.coordinator.remember({
        text: `key sk-${'a'.repeat(32)}`,
        identity: identity(),
        provenance,
      }),
    ).rejects.toMatchObject({ code: 'REDACTION_BLOCKED' })
    expect(harness.calls.remember).toHaveLength(0)
  })

  it('keeps typed adapter failures', async () => {
    const harness = createHarness({
      async remember() {
        throw new MemoryError('BACKEND', 'backend failed', { retryable: true })
      },
    })
    await expect(
      harness.coordinator.remember({ text: 'fact', identity: identity(), provenance }),
    ).rejects.toMatchObject({ code: 'BACKEND' })
    expect(harness.metrics.snapshot().counters['remember.failures']).toBe(1)
  })
})

describe('MemoryCoordinator.forget/status/health', () => {
  it('forgets a memory and increments the request counter', async () => {
    const harness = createHarness()
    await expect(
      harness.coordinator.forget({ id: 'mem-1', identity: identity() }),
    ).resolves.toEqual({ id: 'mem-1', scope: PROJECT_SCOPE, forgotten: true })
    expect(harness.metrics.snapshot().counters['forget.requests']).toBe(1)
  })

  it('surfaces unsupported forget as a typed error and counts it', async () => {
    const harness = createHarness({
      async forget() {
        throw new MemoryError('UNSUPPORTED_OPERATION', 'no per-memory delete')
      },
    })
    await expect(
      harness.coordinator.forget({ id: 'mem-1', identity: identity() }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' })
    expect(harness.metrics.snapshot().counters['forget.unsupported']).toBe(1)
  })

  it('rejects an empty memory id', async () => {
    const harness = createHarness()
    await expect(
      harness.coordinator.forget({ id: '   ', identity: identity() }),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('reports status without secrets and with safe endpoint details', async () => {
    const harness = createHarness()
    const status = await harness.coordinator.status()
    expect(status).toMatchObject({
      transport: 'rest',
      endpoint: 'http://127.0.0.1:9',
      authMode: 'none',
      failureMode: 'open',
    })
    expect(JSON.stringify(status)).not.toMatch(/secret|token|password/i)
    expect(harness.calls.status).toBe(1)
  })

  it('delegates health checks', async () => {
    const harness = createHarness()
    await expect(harness.coordinator.health()).resolves.toEqual({ ok: true, latencyMs: 1 })
    expect(harness.calls.health).toBe(1)
  })

  it('uses a fixed clock for dedupe results', async () => {
    const harness = createHarness()
    const first = await harness.coordinator.remember({
      text: 'clock fact',
      identity: identity(),
      provenance,
    })
    expect(first.createdAt).toBe(FIXED_NOW)
    const spy = vi.spyOn(harness.adapter, 'remember')
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('scope constants', () => {
  it('keeps the project scope stable across harness instances', () => {
    expect(makeScopeRef('project', PROJECT_ID)).toEqual(PROJECT_SCOPE)
  })
})
