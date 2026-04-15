import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    root: '.',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@shadchanai/shared': path.resolve(__dirname, '../shared/types'),
    },
  },
});
