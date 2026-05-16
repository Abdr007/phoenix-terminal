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
    ignores: ['dist/**', 'node_modules/**', 'tests/**', 'docs-site/**', 'Formula/**'],
  },
);
