import type { Project } from '@/types';

export const PROJECT_QUERY_PARAM = 'project';
export const OAUTH_PROJECT_STORAGE_KEY = 'linear_oauth_project';

interface StorageRead {
  getItem(key: string): string | null;
}

interface StorageWrite {
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type StorageLike = StorageRead & StorageWrite;

function defaultSessionStorage(): StorageLike | undefined {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : undefined;
  } catch {
    return undefined;
  }
}

/** Read and trim the `?project=` query parameter from a search string. */
export function readProjectParam(search: string): string | null {
  const raw = new URLSearchParams(search).get(PROJECT_QUERY_PARAM);
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

/**
 * Resolve which project ID to load:
 * 1. Explicit `?project=` query parameter (matching exact ID, case-insensitive ID, or case-insensitive name).
 * 2. Saved project ID from localStorage (if still present in projects).
 * 3. First available project.
 */
export function resolveProjectId(
  projects: Project[],
  requestedProject: string | null | undefined,
  savedProjectId: string | null | undefined,
): string {
  if (projects.length === 0) return '';

  const trimmedRequest = requestedProject?.trim();
  if (trimmedRequest) {
    const lower = trimmedRequest.toLowerCase();
    const matched =
      projects.find((p) => p.id === trimmedRequest) ??
      projects.find((p) => p.id.toLowerCase() === lower) ??
      projects.find((p) => p.name.trim().toLowerCase() === lower);
    if (matched) return matched.id;
  }

  const trimmedSaved = savedProjectId?.trim();
  if (trimmedSaved && projects.some((p) => p.id === trimmedSaved)) {
    return trimmedSaved;
  }

  return projects[0].id;
}

/** Build `/app` or `/app?project=<id>`. */
export function buildAppPathWithProject(projectId?: string | null, basePath = '/app'): string {
  const trimmed = projectId?.trim();
  if (!trimmed) return basePath;
  const params = new URLSearchParams({ [PROJECT_QUERY_PARAM]: trimmed });
  return `${basePath}?${params.toString()}`;
}

/** Build a full deep-link URL `${origin}/app?project=<id>`. */
export function buildProjectDeepLink(origin: string, projectId: string): string {
  const url = new URL('/app', origin);
  url.searchParams.set(PROJECT_QUERY_PARAM, projectId);
  return url.toString();
}

/**
 * Return updated URLSearchParams with `project=<projectId>`, or `null` if already synchronized.
 */
export function syncProjectQueryParam(projectId: string, searchParams: URLSearchParams): URLSearchParams | null {
  if (!projectId) return null;
  if (searchParams.get(PROJECT_QUERY_PARAM) === projectId) return null;
  const next = new URLSearchParams(searchParams);
  next.set(PROJECT_QUERY_PARAM, projectId);
  return next;
}

export function savePendingOAuthProject(
  projectId: string | null | undefined,
  storage: StorageWrite | undefined = defaultSessionStorage(),
): void {
  if (!storage) return;
  try {
    const trimmed = projectId?.trim();
    if (trimmed) storage.setItem(OAUTH_PROJECT_STORAGE_KEY, trimmed);
    else storage.removeItem(OAUTH_PROJECT_STORAGE_KEY);
  } catch {
    // Ignore storage errors (private mode, disabled storage, etc.)
  }
}

export function peekPendingOAuthProject(storage: StorageRead | undefined = defaultSessionStorage()): string | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(OAUTH_PROJECT_STORAGE_KEY);
    const trimmed = raw?.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

export function clearPendingOAuthProject(
  storage: Pick<StorageWrite, 'removeItem'> | undefined = defaultSessionStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(OAUTH_PROJECT_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
}

export function consumePendingOAuthProject(storage: StorageLike | undefined = defaultSessionStorage()): string | null {
  const value = peekPendingOAuthProject(storage);
  if (value !== null) clearPendingOAuthProject(storage);
  return value;
}

/** Resolve the `/app` redirect path after OAuth callback, preserving any pending `?project=` parameter. */
export function resolvePostOAuthRedirectPath(
  search: string,
  storage: StorageLike | undefined = defaultSessionStorage(),
): string {
  const project = readProjectParam(search) ?? consumePendingOAuthProject(storage);
  return buildAppPathWithProject(project);
}

/** Build the GCP `/api/linear/authorize` URL and persist any `?project=` across the OAuth round-trip. */
export function buildGcpLinearAuthorizeUrl(
  search: string,
  storage: StorageLike | undefined = defaultSessionStorage(),
): string {
  const fromUrl = readProjectParam(search);
  if (fromUrl) savePendingOAuthProject(fromUrl, storage);
  const project = fromUrl ?? peekPendingOAuthProject(storage);
  if (!project) return '/api/linear/authorize';
  const params = new URLSearchParams({ [PROJECT_QUERY_PARAM]: project });
  return `/api/linear/authorize?${params.toString()}`;
}
