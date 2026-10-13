import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', Buffer: 'readonly', fetch: 'readonly', URLSearchParams: 'readonly', Request: 'readonly', Response: 'readonly', Headers: 'readonly' } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['error'] }],
    },
  },
  { files: ['deploy/**/*.cjs'], languageOptions: { sourceType: 'commonjs', globals: { module: 'writable', __dirname: 'readonly' } } },
);
