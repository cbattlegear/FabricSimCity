import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'src') },
  },
  /*
   * es2022, in the Vite 8 spelling. Vitest 5 transforms with **oxc**, and the `esbuild` key this
   * replaces is still accepted and silently *ignored* — the run logs `oxc options will be used and
   * esbuild options will be ignored` and carries on, leaving the tests on oxc's default target
   * rather than the one named here. Under Vitest 3 the old key was honoured and no warning fired,
   * so the bump is what turned this line into dead config.
   *
   * It has to match `vite.config.ts` because decorators are the reason es2022 is pinned at all: a
   * suite transformed at a different syntax level than the bundle can pass while the build fails.
   */
  oxc: { target: 'es2022' },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    /*
     * Neutralize the app's runtime configuration for the whole suite.
     *
     * Vitest loads `.env` files through Vite, and a successful `rayfin up` writes a real
     * `.env.local` containing `VITE_RAYFIN_API_URL`. That variable is what selects fixture mode, so
     * without this the suite passes on a fresh clone and in CI and then fails on any machine that
     * has ever deployed — ambient state deciding the result, which is the one thing a suite must
     * never do. Tests that want a configured backend stub it explicitly with `vi.stubEnv`.
     */
    env: {
      VITE_FABRIC_SOURCE: '',
      VITE_RAYFIN_API_URL: '',
      VITE_RAYFIN_PUBLISHABLE_KEY: '',
      VITE_RAYFIN_FUNCTIONS_URL: '',
      VITE_FABRIC_WORKSPACE_ID: '',
      VITE_FABRIC_ITEM_ID: '',
      VITE_FABRIC_PORTAL_URL: '',
      VITE_FABRIC_TENANT_ID: '',
      VITE_FABRIC_TENANT_NAME: '',
      VITE_FABRIC_METRICS_DATASET_ID: '',
      VITE_FABRIC_METRICS_PROXY_URL: '',
      VITE_FABRIC_INGEST_INTERVAL_MINUTES: '',
      VITE_FABRIC_INGEST_WINDOW_DAYS: '',
    },
  },
})
