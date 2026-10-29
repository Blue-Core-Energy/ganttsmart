import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    // Same aliases as vite.config.ts; tests run against the Supabase implementation.
    alias: [
      { find: '@/backend/impl', replacement: path.resolve(__dirname, './src/backend/supabase/index.ts') },
      { find: '@', replacement: path.resolve(__dirname, './src') },
    ],
  },
  test: {
    environment: 'node',
    include: ['server/test/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
