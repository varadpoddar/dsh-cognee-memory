import { describe, expect, it } from 'vitest'
import {
  COGNEE_API_VERIFICATION,
  COGNEE_MCP_TOOLS,
  COGNEE_PATHS,
} from '../src/adapters/cognee-paths.js'

describe('Cognee path constants', () => {
  it('marks all paths unverified because no Cognee docs are archived', () => {
    expect(COGNEE_API_VERIFICATION.verified).toBe(false)
    expect(COGNEE_API_VERIFICATION.note).toMatch(/UNVERIFIED/)
  })

  it('isolates every REST path in one frozen object', () => {
    expect(COGNEE_PATHS.add).toBe('/api/v1/add')
    expect(COGNEE_PATHS.search).toBe('/api/v1/search')
    expect(COGNEE_PATHS.datasets).toBe('/api/v1/datasets')
    expect(COGNEE_PATHS.delete).toBe('/api/v1/delete')
    expect(Object.isFrozen(COGNEE_PATHS)).toBe(true)
  })

  it('does not define a dataset-delete path', () => {
    expect(Object.values(COGNEE_PATHS).some((path) => /datasets.*delete|delete.*datasets/i.test(path))).toBe(false)
    expect(Object.keys(COGNEE_PATHS)).not.toContain('datasetDelete')
  })

  it('marks MCP tool names unverified and frozen', () => {
    expect(Object.isFrozen(COGNEE_MCP_TOOLS)).toBe(true)
    expect(COGNEE_MCP_TOOLS.forget).toContain('forget')
  })
})
