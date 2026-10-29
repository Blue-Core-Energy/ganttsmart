import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import globals from 'globals';

const sharedTsRules = {
  'no-console': ['warn', { allow: ['warn', 'error'] }],
  '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  '@typescript-eslint/no-explicit-any': 'warn',
};

export default tseslint.config(
  { ignores: ['dist', 'server-dist'] },
  {
    // Browser app (and root build configs). The server has its own block below.
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    ignores: ['server/**'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      ...sharedTsRules,
    },
  },
  {
    // Node server (Cloud Run): Node globals, no React rules.
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['server/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.node,
    },
    rules: sharedTsRules,
  },
);
