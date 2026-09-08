import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig, loadEnv, type ProxyOptions } from 'vite'

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

  /*
   * Bearer token for the Capacity Metrics proxy below.
   *
   * Read with an empty prefix and deliberately *not* named `VITE_`, because only `VITE_`-prefixed
   * variables are inlined into the bundle — this one is used solely here, in Node, and so never
   * reaches the browser. Naming it `VITE_POWERBI_TOKEN` would publish a live Power BI token to
   * every visitor of the built site.
   */
  const secrets = loadEnv(mode, process.cwd(), '')
  const powerBiToken = process.env.POWERBI_TOKEN ?? secrets.POWERBI_TOKEN

  /*
   * Same-origin forwarder for the Power BI REST API.
   *
   * `executeQueries` sends no `Access-Control-Allow-Origin`, so the browser cannot call
   * `api.powerbi.com` directly whatever token it holds. The dev server is a Node process and is
   * not subject to CORS, so it relays the call and attaches the token. This exists only in
   * development: the deployed Fabric app is static hosting with nowhere to run a forwarder, which
   * is why the semantic-model source is a local capability today. See README.
   */
  const proxy = {
    '/powerbi': {
      target: 'https://api.powerbi.com',
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/powerbi/, ''),
      configure: (instance) => {
        instance.on('proxyReq', (proxyReq) => {
          if (powerBiToken) proxyReq.setHeader('authorization', `Bearer ${powerBiToken}`)
        })
      },
    },
  } satisfies Record<string, ProxyOptions>

  if (!powerBiToken && mode !== 'production') {
    // Not fatal: the proxy still forwards, and Power BI answers 401, which the client reports as
    // `Unauthenticated` rather than as a confusing network error.
    console.info(
      '[fabricsimcity] POWERBI_TOKEN is unset — the Capacity Metrics proxy will forward unauthenticated.\n' +
        '                az login --scope https://analysis.windows.net/powerbi/api/.default\n' +
        '                $env:POWERBI_TOKEN = az account get-access-token --resource https://analysis.windows.net/powerbi/api --query accessToken -o tsv',
    )
  }

  return {
    plugins: [react()],
    resolve: {
      alias: { '@': resolve(import.meta.dirname, 'src') },
    },
    server: { ...(port ? { port, strictPort: true } : {}), proxy },
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
