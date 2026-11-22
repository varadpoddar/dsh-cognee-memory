import { describe, expect, it } from 'vitest'
import {
  COGNEE_API_VERIFICATION,
  COGNEE_MCP_TOOLS,
  COGNEE_PATHS,
  isPipelineComplete,
  isPipelineFailed,
} from '../src/adapters/cognee-paths.js'

describe('Cognee path constants', () => {
  it('records the live verification instead of claiming the paths are unverified', () => {
    expect(COGNEE_API_VERIFICATION.verified).toBe(true)
    expect(COGNEE_API_VERIFICATION.source).toMatch(/live probes/)
    expect(COGNEE_API_VERIFICATION.probes.length).toBeGreaterThan(5)
  })

  it('isolates every verified REST path in one frozen object', () => {
    expect(COGNEE_PATHS.add).toBe('/api/v1/add')
    expect(COGNEE_PATHS.remember).toBe('/api/v1/remember')
    expect(COGNEE_PATHS.search).toBe('/api/v1/search')
    expect(COGNEE_PATHS.forget).toBe('/api/v1/forget')
    expect(COGNEE_PATHS.datasets).toBe('/api/v1/datasets')
    expect(COGNEE_PATHS.whoami).toBe('/api/v1/users/me')
    expect(COGNEE_PATHS.health).toBe('/health')
    expect(COGNEE_PATHS.datasetData('abc')).toBe('/api/v1/datasets/abc/data')
    expect(COGNEE_PATHS.processingStatus('abc')).toBe('/api/v1/datasets/abc/processing-status')
    expect(Object.isFrozen(COGNEE_PATHS)).toBe(true)
  })

  it('does not define a dataset-delete path reachable from the adapter', () => {
    const strings: string[] = []
    for (const value of Object.values(COGNEE_PATHS)) {
      if (typeof value === 'string') strings.push(value)
    }
    expect(strings.some((path) => /datasets.*delete|delete.*datasets|^\/api\/v1\/delete$/i.test(path))).toBe(false)
    expect(Object.keys(COGNEE_PATHS)).not.toContain('datasetDelete')
  })

  it('accepts every completion string the live instance returns', () => {
    for (const status of ['completed', 'PipelineRunCompleted', 'DATASET_PROCESSING_COMPLETED']) {
      expect(isPipelineComplete(status)).toBe(true)
    }
    expect(isPipelineComplete('DATASET_PROCESSING_FAILED')).toBe(false)
    expect(isPipelineFailed('PipelineRunFailed')).toBe(true)
    expect(isPipelineFailed(undefined)).toBe(false)
  })

  it('marks MCP tool names frozen', () => {
    expect(Object.isFrozen(COGNEE_MCP_TOOLS)).toBe(true)
    expect(COGNEE_MCP_TOOLS.forget).toContain('forget')
  })
})
