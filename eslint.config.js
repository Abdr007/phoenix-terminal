import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'max-lines': ['warn', { max: 1200, skipBlankLines: true, skipComments: true }],
      'no-constant-condition': 'off',
      'consistent-return': 'off',
      'no-floating-promises': 'off',
    },
  },
  {
    // Tests get linted too (phase 11) — but with relaxed rules since vitest
    // tests intentionally use `any` casts on mock shapes and have lots of
    // setup-time helpers that look "unused" until describe() runs them.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'max-lines': 'off',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'docs-site/**', 'Formula/**'],
  },
);
