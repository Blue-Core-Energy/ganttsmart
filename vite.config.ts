import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

const BACKENDS = ['supabase', 'gcp'];

export default defineConfig(({ mode }) => {
  // Empty prefix: also picks up a plain shell env var (VITE_BACKEND=gcp npm run build)
  const env = loadEnv(mode, process.cwd(), '');
  const backend = env.VITE_BACKEND || 'supabase';
  if (!BACKENDS.includes(backend)) {
    throw new Error(`Invalid VITE_BACKEND "${backend}": expected one of ${BACKENDS.join(', ')}`);
  }

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      // '@/backend/impl' must come before '@' so the more specific alias wins
      alias: [
        { find: '@/backend/impl', replacement: path.resolve(__dirname, `./src/backend/${backend}/index.ts`) },
        { find: '@', replacement: path.resolve(__dirname, './src') },
      ],
    },
    build: {
      target: 'es2023',
      sourcemap: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/')) {
              return 'react';
            }
            if (id.includes('node_modules/react-router')) {
              return 'router';
            }
            if (id.includes('node_modules/@supabase')) {
              return 'supabase';
            }
          },
        },
      },
    },
  };
});
