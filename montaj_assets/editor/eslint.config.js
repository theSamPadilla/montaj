import tseslint from 'typescript-eslint'

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      // Allow intentionally-unused args/vars when prefixed with `_` (the
      // convention used throughout the ported editor-core code — test stubs
      // and adapter no-ops that must satisfy a signature).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/*', '@/app/*', '@/lib/*', '@/components/*'],
              message: '@bycrux/editor must not import from the host app (@/ paths).',
            },
          ],
        },
      ],
    },
  },
)
