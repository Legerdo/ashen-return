import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __E2E__: 'false',
    __GAME_VERSION__: JSON.stringify('1.0.0'),
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 60_000,
    reporters: ['default', ['json', { outputFile: 'test-results/unit-results.json' }]],
  },
});
