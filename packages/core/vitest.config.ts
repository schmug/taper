import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Property tests run 10k cases each (HANDOFF §9 M1).
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
    },
  },
});
