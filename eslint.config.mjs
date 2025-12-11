import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // The codebase currently uses `any` in many places; keep signal without blocking merges/builds.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Avoid hard-failing on unescaped quotes in JSX content.
      'react/no-unescaped-entities': 'warn',
      // Keep lint non-blocking while we gradually clean up.
      'prefer-const': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      'react/jsx-no-comment-textnodes': 'warn',
      '@next/next/no-assign-module-variable': 'warn',
      // The codebase uses some patterns these rules flag; treat as advisory for now.
      'react-hooks/immutability': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/static-components': 'off',
      'react-hooks/purity': 'off',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-duplicate-enum-values': 'warn',
      '@typescript-eslint/no-unsafe-function-type': 'warn',
    },
  },
  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Legacy script (not part of the app build) contains syntax that ESLint chokes on.
    'diesel_excel_parser.js',
  ]),
])

export default eslintConfig
