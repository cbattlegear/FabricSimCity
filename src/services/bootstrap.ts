import type { IAuthService } from './IAuthService';
import { MockAuthService } from './MockAuthService';
import { RayfinAuthService } from './RayfinAuthService';
import { initRayfinClient } from './rayfinClient';

function isLocalBackendUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/**
 * Whether the app should run entirely on synthetic evidence.
 *
 * Fixture mode is the primary development loop, not a fallback: Rayfin has no local backend and
 * no `rayfin dev`, so without it the city is undevelopable without a Fabric tenant. It is on by
 * default whenever no backend has been configured, because the alternative — throwing on a
 * missing `VITE_RAYFIN_PUBLISHABLE_KEY` — turns a fresh clone into an error page.
 */
export function isFixtureMode(): boolean {
  const explicit = import.meta.env.VITE_FABRIC_SOURCE
  if (explicit) return explicit === 'fixture'
  return !import.meta.env.VITE_RAYFIN_API_URL
}

/**
 * Read VITE_* env vars, initialize the Rayfin client, and return the right
 * auth service for the target backend.
 *
 * - Localhost API URL → {@link MockAuthService}
 * - Anything else     → {@link RayfinAuthService} (requires VITE_FABRIC_* vars)
 *
 * Callers must check {@link isFixtureMode} first. There is no identity to establish when nothing
 * is being read from a tenant, and asking for one would gate the fixtures behind a sign-in that
 * cannot succeed.
 */
export function bootstrapAuth(): IAuthService {
  const apiUrl = import.meta.env.VITE_RAYFIN_API_URL || 'http://localhost:5168';
  const localDev = isLocalBackendUrl(apiUrl);
  const publishableKey = import.meta.env.VITE_RAYFIN_PUBLISHABLE_KEY;

  if (!publishableKey && !localDev) {
    throw new Error(
      'VITE_RAYFIN_PUBLISHABLE_KEY environment variable is required'
    );
  }

  const client = initRayfinClient({
    baseUrl: apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`,
    publishableKey: publishableKey ?? 'local-dev-key',
    functionsBaseUrl: localDev
      ? import.meta.env.VITE_RAYFIN_FUNCTIONS_URL
      : undefined,
    localDev,
  });

  if (localDev) {
    return new MockAuthService(client);
  }

  const workspaceId = import.meta.env.VITE_FABRIC_WORKSPACE_ID;
  const projectId = import.meta.env.VITE_FABRIC_ITEM_ID;
  const fabricPortalUrl = import.meta.env.VITE_FABRIC_PORTAL_URL;

  if (!workspaceId || !projectId || !fabricPortalUrl) {
    throw new Error(
      'Missing required Fabric config. Set VITE_FABRIC_WORKSPACE_ID, VITE_FABRIC_ITEM_ID, and VITE_FABRIC_PORTAL_URL.'
    );
  }

  return new RayfinAuthService(client, {
    workspaceId,
    projectId,
    fabricPortalUrl,
    returnOrigin: window.location.origin,
  });
}
