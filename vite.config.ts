import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// In dev, the Vite dev server hosts the client (port 5173) and proxies the API
// and the game WebSocket to the standalone Node server (port 8787) so the
// browser talks to a single origin — exactly like production, where the Node
// server serves the built client AND the socket from one port.
const SERVER_PORT = process.env.SERVER_PORT || process.env.PORT || '8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // One copy of three.js: addons import 'three' and must resolve to the same module.
  resolve: { dedupe: ['three'] },
  server: {
    port: 5173,
    // Agent worktrees live under .claude/worktrees; don't let their edits reload the dev tab.
    watch: { ignored: ['**/.claude/**', '**/dist/**'] },
    proxy: {
      '/api': { target: `http://localhost:${SERVER_PORT}`, changeOrigin: true },
      '/ws': { target: `ws://localhost:${SERVER_PORT}`, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});
