import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': `${import.meta.dirname}/src`
    }
  },
  server: {
    port: 3000,
    // Local dev only: the frontend calls the backend via relative paths
    // because Traefik serves both from one origin in the real stack (see
    // frontend/.env.example). When the Vite dev server runs alongside the
    // local backend it yields to the next free port (3001), so /api and
    // /socket.io must be proxied back to the backend on 3000 or every API
    // call 404s.
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:3000', ws: true },
      // Local dev only: in the real stack Traefik routes /webrtc to MediaMTX's
      // WHEP endpoint (docker/traefik/dynamic-mediamtx.yml strips the /webrtc
      // prefix). Mirror that here so the Vite dev server can reach WHEP on
      // localhost:8889 (MediaMTX started via tools/run-local-mediamtx.sh).
      '/webrtc': {
        target: 'http://localhost:8889',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/webrtc/, '')
      }
    }
  }
});
