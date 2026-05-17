import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    // Type-aware rules need projectService to access the type checker.
    // Only enable for src/ — tests aren't in tsconfig.include.
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'max-lines': ['warn', { max: 1200, skipBlankLines: true, skipComments: true }],
      'no-constant-condition': 'off',
      'consistent-return': 'off',
      // High-value type-aware rules — surface real async bugs
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      '@typescript-eslint/await-thenable': 'error',
    },
  },
  {
    // Tests get linted too, but with NO type-aware rules (tests aren't in
    // tsconfig.include, so projectService can't reach them). Style-only.
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
