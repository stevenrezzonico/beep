import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

// Multi-page static site: landing page, bench and end-user app. No server-side code.
// getUserMedia needs a secure context on phones: put a mkcert certificate in ./cert/ (see
// README "Testing on phones") and `npm run dev:lan` serves HTTPS on the LAN.
const certDir = resolve(import.meta.dirname, 'cert');
const key = resolve(certDir, 'key.pem');
const cert = resolve(certDir, 'cert.pem');
const https = existsSync(key) && existsSync(cert) ? { key: readFileSync(key), cert: readFileSync(cert) } : undefined;

export default defineConfig({
  base: './',
  server: { https },
  preview: { https },
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
