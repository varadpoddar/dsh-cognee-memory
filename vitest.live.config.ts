import { defineConfig } from 'vitest/config'

/**
 * Live integration suite. Requires a reachable Cognee instance and
 * `COGNEE_API_KEY` in the environment; every test is skipped without it.
 *
 *   COGNEE_API_KEY=... npm run test:live
 */
export default defineConfig({
  test: {
    include: ['test/live/**/*.test.ts'],
    environment: 'node',
    testTimeout: 600_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    restoreMocks: true,
    clearMocks: true,
  },
})
