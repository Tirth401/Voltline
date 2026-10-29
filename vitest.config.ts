import { configDefaults, defineConfig } from 'vitest/config';

// Unit tests sit next to the code as *.test.ts and need nothing running.
// Tests that need Postgres or Redis are *.int.test.ts (or live in tests/) and run separately.
const integrationTests = ['**/*.int.test.ts', 'tests/**/*.test.ts'];

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: [
            'packages/*/src/**/*.test.ts',
            'services/*/src/**/*.test.ts',
            'simulator/src/**/*.test.ts',
          ],
          exclude: [...configDefaults.exclude, ...integrationTests],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: integrationTests,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
