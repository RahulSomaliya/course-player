import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev: the web app runs on Vite (5173) and proxies the API + media to the
// course server (8795). Prod: the server serves dist/web itself on 8795.
export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8795', '/media': 'http://localhost:8795' },
  },
  test: {
    root: '.',
    include: ['server/**/*.test.ts', 'shared/**/*.test.ts', 'web/src/**/*.test.{ts,tsx}'],
  },
});
