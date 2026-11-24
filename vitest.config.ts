import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    // Same aliases as vite.config.ts; tests run against the Supabase implementation.
    alias: [
      { find: /^jsr:@supabase\/supabase-js(@.*)?$/, replacement: '@supabase/supabase-js' },
      { find: '@/backend/impl', replacement: path.resolve(import.meta.dirname, './src/backend/supabase/index.ts') },
      { find: '@', replacement: path.resolve(import.meta.dirname, './src') },
    ],
  },
  test: {
    pool: 'vmThreads',
    environment: 'node',
    include: ['server/test/**/*.test.ts', 'src/**/*.test.ts', 'src/**/*.test.tsx', 'supabase/functions/**/*.test.ts'],
  },
});
