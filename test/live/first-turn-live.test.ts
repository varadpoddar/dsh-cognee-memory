import { describe, expect, it } from 'vitest'
import { createMemoryAdapter } from '../../src/adapters/memory-adapter.js'
import { parseConfig } from '../../src/config/schema.js'
import { MemoryPromptContext, estimateTokens } from '../../src/hooks/prompt-context.js'
import { MemoryCoordinator } from '../../src/memory/coordinator.js'
import { identityFromAgent } from '../../src/memory/scopes.js'
import { Metrics } from '../../src/telemetry/metrics.js'

/**
 * Live proof of the first-turn retrieval path against the deployed Cognee.
 *
 * Skipped unless `COGNEE_API_KEY` is set. Read-only: it queries the existing
 * project dataset that holds the acceptance fixture and never writes.
 *
 * The deployed profile scope is `scopeDefaults.projectId: dsh/project/e2e`,
 * whose hashed scope id (`project-4be96e7c2cdbb95a1ac9`) is the live dataset
 * `dsh_cognee_project_project-4be96e7c2cdbb95a1ac9` (3d8d8ad8-41be-59c3-9310-7915c783e5ef).
 */
const apiKey = process.env.COGNEE_API_KEY?.trim()
const baseUrl = (process.env.COGNEE_BASE_URL ?? 'http://10.20.10.15:8000/api/v1').replace(/\/+$/, '')
const QUESTION = 'What is the release codename and the deployment target?'

function controllerFor(projectId: string) {
  const metrics = new Metrics()
  const config = parseConfig({
    transport: 'rest',
    apiBaseUrl: baseUrl,
    authMode: 'api-key',
    apiTokenEnv: 'COGNEE_API_KEY',
    scopeDefaults: { projectId },
    recall: { searchType: 'CHUNKS' },
  })
  const adapter = createMemoryAdapter({ config, metrics, env: process.env, endpoint: () => baseUrl })
  const coordinator = new MemoryCoordinator({ adapter, config, metrics, endpoint: () => baseUrl })
  const controller = new MemoryPromptContext({
    recall: coordinator.recallService,
    config,
    identity: identityFromAgent({ session: { id: 'live-first-turn' } }),
    metrics,
  })
  return { controller, metrics, config }
}

describe.skipIf(apiKey === undefined || apiKey === '')('first-turn prefetch (live Cognee)', () => {
  it('delivers the acceptance fixture in the first assembly within budget', async () => {
    const { controller, config } = controllerFor('dsh/project/e2e')
    const started = Date.now()
    controller.beginPrefetch({ turn: 1, query: QUESTION })
    const block = await controller.resolveForAssembly({})
    const elapsed = Date.now() - started
    expect(block).toContain('amber-otter-7731')
    expect(block).toContain('CT 103')
    expect(estimateTokens(block)).toBeLessThanOrEqual(
      config.retrieval.stableTokens + config.retrieval.queryTokens,
    )
    expect(elapsed).toBeLessThan(config.prefetch.timeoutMs + 1_000)
    expect(config.retrieval.maxItems).toBe(8)
  }, 30_000)

  it('does not return another project\'s fixture for a different project scope', async () => {
    const { controller } = controllerFor('dsh/project/other-scope')
    controller.beginPrefetch({ turn: 1, query: QUESTION })
    const block = await controller.resolveForAssembly({})
    // User/agent scopes are readable by design, so the block need not be empty;
    // project isolation is proven by the absent project-scoped fixture.
    expect(block).not.toContain('amber-otter-7731')
    expect(block).not.toContain('CT 103')
  }, 30_000)
})
