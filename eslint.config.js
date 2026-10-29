// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['coverage/', 'packages/ocpp/schemas/', '**/*.generated.ts'] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // An un-awaited promise in a socket handler is how an ack goes out before its commit (D-005).
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // `const { dropped, ...kept } = value` is the idiomatic way to omit fields.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
      // Session and connection state machines must handle every state.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      eqeqeq: 'error',
      // Every random choice must come from a seed so the scenario can be regenerated (D-011).
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Use Prng from @voltline/common so the run can be reproduced from its seed.',
        },
      ],
    },
  },
  { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },
);
