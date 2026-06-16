import tseslint from 'typescript-eslint'

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
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
