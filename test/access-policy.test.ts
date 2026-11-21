import { describe, expect, it } from 'vitest'
import { MemoryError } from '../src/errors.js'
import { buildAccessPolicy, AccessPolicy } from '../src/security/access-policy.js'
import { makeScopeRef, globalScope } from '../src/memory/scopes.js'
import type { ScopeRef } from '../src/types.js'

const session = makeScopeRef('session', 's1')
const project = makeScopeRef('project', '/workspace/demo')
const foreign = makeScopeRef('session', 'other')

describe('AccessPolicy', () => {
  it('denies by default', () => {
    const policy = new AccessPolicy([session])
    expect(policy.canRead(session)).toBe(true)
    expect(policy.canRead(project)).toBe(false)
    expect(() => policy.assertReadable(project)).toThrow(MemoryError)
  })

  it('filters backend rows outside the caller scopes', () => {
    const policy = buildAccessPolicy([session, project])
    const rows = [
      { id: '1', scope: session },
      { id: '2', scope: foreign },
      { id: '3', scope: project },
    ]
    expect(policy.filterReadable(rows).map((row) => row.id)).toEqual(['1', '3'])
  })

  it('separates write scopes from read scopes', () => {
    const policy = buildAccessPolicy([session, project], { writeScopes: [project] })
    expect(policy.canRead(session)).toBe(true)
    expect(policy.canWrite(session)).toBe(false)
    expect(policy.canWrite(project)).toBe(true)
    expect(() => policy.assertWritable(session)).toThrow(/not writable/)
  })

  it('exposes a frozen copy of readable scopes', () => {
    const policy = buildAccessPolicy([session])
    expect(policy.readableScopes).toEqual([session])
    expect(Object.isFrozen(policy.readableScopes)).toBe(true)
  })

  it('treats a structurally equal scope as authorized', () => {
    const policy = buildAccessPolicy([{ ...session } as ScopeRef])
    expect(policy.canRead(session)).toBe(true)
    expect(policy.canRead(globalScope())).toBe(false)
  })
})
