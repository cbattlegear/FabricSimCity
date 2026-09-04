import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig, loadEnv } from 'vite'

/*
 * `@vitejs/plugin-react` (esbuild), deliberately not `-swc`.
 *
 * Rayfin entities use TC39 Stage 3 decorators and SWC cannot parse them — it fails with
 * `Expression expected`. Nothing under `src/` declares an entity today, and `rayfin/` is compiled
 * by `tsc` rather than by Vite, so SWC would work right up until the first entity class is
 * imported into the frontend for a value rather than a type. esbuild costs nothing here and
 * removes that trap entirely.
 */
export default defineConfig(({ mode }) => {
  /*
   * The dev server port is pinned to Rayfin's per-project `RAYFIN_PUBLIC_FRONTEND_PORT`, mapped
   * to `VITE_PORT` by `rayfin env`. The deployed backend allow-lists that one origin, so a
   * floating port silently breaks Fabric sign-in. Fixture mode has no backend and no allow-list,
   * so it falls back to Vite's default.
   */
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const port = env.VITE_PORT ? Number(env.VITE_PORT) : undefined

  return {
    plugins: [react()],
    resolve: {
      alias: { '@': resolve(import.meta.dirname, 'src') },
    },
    ...(port ? { server: { port, strictPort: true } } : {}),
    /*
     * es2022 in all three places. Rayfin's decorators need it at build, at transform, and in
     * prebundled dependencies; setting only `build.target` leaves dev serving a different syntax
     * level than the bundle ships, which fails at runtime rather than at build.
     */
    build: { target: 'es2022' },
    esbuild: { target: 'es2022' },
    optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  }
})
