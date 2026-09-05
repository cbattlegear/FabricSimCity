import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig, loadEnv } from 'vite'

/*
 * `@vitejs/plugin-react`, deliberately not `-swc` and deliberately not the v6 line.
 *
 * Rayfin entities use TC39 Stage 3 decorators. SWC cannot parse them — it fails with
 * `Expression expected`. Nothing under `src/` declares an entity today, and `rayfin/` is compiled
 * by `tsc` rather than by Vite, so a parser that chokes on decorators would work right up until the
 * first entity class is imported into the frontend for a value rather than a type. That is a trap
 * worth keeping shut rather than discovering later.
 *
 * Vite 8 transforms with **oxc**, not esbuild. Oxc was measured against this constraint rather than
 * assumed: a Stage 3 decorator reachable from `src/main.tsx` builds, and the decorator runs both at
 * class definition and at call. The plugin stays on v5 because v6 peers on `oxc-transform-react`
 * and changes the React transform itself; v5 supports Vite 8 and changes nothing here.
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
     * es2022 in all three places. Decorators need it at build, at transform, and in prebundled
     * dependencies; setting only `build.target` leaves dev serving a different syntax level than
     * the bundle ships, which fails at runtime rather than at build.
     *
     * These are the Vite 8 spellings. The `esbuild` and `optimizeDeps.esbuildOptions` keys these
     * replace are still accepted and are silently *ignored* — Vite logs `oxc options will be used
     * and esbuild options will be ignored` and carries on building — so keeping the old names
     * would have quietly reduced this from three places to one.
     */
    build: { target: 'es2022' },
    oxc: { target: 'es2022' },
    optimizeDeps: { rolldownOptions: { transform: { target: 'es2022' } } },
  }
})
