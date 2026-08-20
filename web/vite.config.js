import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * /api is proxied to the Express server, so the browser only ever talks to one
 * origin and needs no environment configuration of its own. Nothing about the
 * Zoom credentials reaches the client bundle.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_TARGET || 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
