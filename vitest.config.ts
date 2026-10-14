import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/unit/**/*.test.ts'],
          exclude: ['src/server/sandbox/**/*.test.ts', 'tests/integration/**'],
          fileParallelism: false,
          environment: 'node',
        },
      },
      {
        test: {
          name: 'pglite',
          include: ['src/server/sandbox/**/*.test.ts', 'tests/pglite/**/*.test.ts'],
          pool: 'forks',
          fileParallelism: false,
          testTimeout: 20000,
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          pool: 'forks',
          fileParallelism: false,
          testTimeout: 20000,
          environment: 'node',
        },
      },
    ],
  },
});
