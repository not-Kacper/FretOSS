/// <reference types="vitest" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Standard Vite + React + TS config — nothing special, by design.
 *
 * `public/` is copied verbatim into `dist/`, which is what keeps
 * `/worklets/pitch-processor.js` a standalone file: the AudioWorklet is loaded
 * with `audioWorklet.addModule()`, so it must NOT be bundled or transformed by
 * Vite (no plugin touches `public/`). Same for `/config.json`, which the client
 * fetches at startup exactly like main.py read it from disk.
 *
 * Host entries only affect where the dev server is reachable from (the sandbox
 * preview proxies to it under a different hostname).
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    // `npm run dev` needs the microphone, which browsers only allow on a secure
    // context — localhost counts as secure, so no extra setup is required.
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
