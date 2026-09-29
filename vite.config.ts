import { defineConfig } from 'vite';

// Static-host friendly build: relative base so dist/ works from any path on a plain HTTP(S) server.
export default defineConfig(({ mode }) => ({
  base: './',
  define: {
    __E2E__: JSON.stringify(mode === 'e2e'),
    __GAME_VERSION__: JSON.stringify('1.0.0'),
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4000,
    sourcemap: mode === 'e2e',
  },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
}));
