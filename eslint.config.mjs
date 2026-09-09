import obsidianmd from 'eslint-plugin-obsidianmd';
import tsparser from '@typescript-eslint/parser';

export default [
  ...obsidianmd.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: process.cwd(),
      },
    },
  },
];
