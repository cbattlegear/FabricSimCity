import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'src') },
  },
  esbuild: { target: 'es2022' },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    /*
     * `src/pending-port` holds the city modules still carrying SQL Server semantics. They are kept
     * in the tree because they are the port's remaining work and their history is worth reading,
     * but they are not part of the shipped app and their tests assert against contracts that no
     * longer exist. Excluded here and in `tsconfig.json` so the two agree.
     */
    exclude: ['node_modules', 'dist', 'src/pending-port/**'],
  },
})
