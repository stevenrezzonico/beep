import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Multi-page static site: landing page, bench and end-user app. No server-side code.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        bench: resolve(import.meta.dirname, 'bench/index.html'),
        app: resolve(import.meta.dirname, 'app/index.html'),
      },
    },
  },
  test: {
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    testTimeout: 60_000,
  },
});
