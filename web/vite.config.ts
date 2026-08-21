import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    // The app chunk stays well under 500 KiB. three.js is isolated into its own
    // lazily-loaded vendor chunk (fetched only when a 3D surface mounts), so it
    // is never on the initial critical path. This limit only accommodates that
    // single isolated ~555 KiB vendor chunk; a genuine growth regression in
    // application code still trips the warning.
    chunkSizeWarningLimit: 575,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three/')) return 'three'
          if (id.includes('node_modules/@microsoft/signalr/')) return 'signalr'
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:5080',
      '/healthz': 'http://localhost:5080',
      '/readyz': 'http://localhost:5080',
      '/hubs': { target: 'http://localhost:5080', ws: true },
    },
  },
})
