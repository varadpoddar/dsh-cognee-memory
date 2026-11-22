import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Live tests require a reachable Cognee instance; run them with `test:live`.
    exclude: ['test/live/**', 'node_modules/**', 'lib/**'],
    environment: 'node',
    testTimeout: 15_000,
    hookTimeout: 15_000,
    restoreMocks: true,
    clearMocks: true,
  },
})
