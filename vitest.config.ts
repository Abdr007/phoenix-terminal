import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/plugins/_example-plugin.ts',
        'src/build-info.ts',
      ],
      thresholds: {
        lines: 25,
        functions: 55,
        branches: 75,
      },
    },
  },
});
