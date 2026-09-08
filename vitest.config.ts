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
  },
})
