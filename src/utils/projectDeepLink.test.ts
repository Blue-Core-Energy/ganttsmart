import { describe, expect, it } from 'vitest';
import type { Project } from '@/types';
import {
  OAUTH_PROJECT_STORAGE_KEY,
  buildAppPathWithProject,
  buildGcpLinearAuthorizeUrl,
  buildProjectDeepLink,
  clearPendingOAuthProject,
  consumePendingOAuthProject,
  peekPendingOAuthProject,
  readProjectParam,
  resolvePostOAuthRedirectPath,
  resolveProjectId,
  savePendingOAuthProject,
  syncProjectQueryParam,
  type StorageLike,
} from './projectDeepLink';

function makeMemoryStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

const PROJECTS: Project[] = [
  { id: 'proj-1', name: 'Alpha Platform' },
  { id: 'proj-2', name: 'Beta Mobile' },
  { id: 'proj-3', name: 'Demo Project' },
];

describe('readProjectParam', () => {
  it('reads and trims the project query parameter', () => {
    expect(readProjectParam('?project=proj-2')).toBe('proj-2');
    expect(readProjectParam('?foo=1&project=%20proj-2%20')).toBe('proj-2');
  });

  it('returns null when project parameter is missing or blank', () => {
    expect(readProjectParam('')).toBeNull();
    expect(readProjectParam('?foo=bar')).toBeNull();
    expect(readProjectParam('?project=')).toBeNull();
    expect(readProjectParam('?project=%20%20')).toBeNull();
  });
});

describe('resolveProjectId', () => {
  it('prefers ?project= over saved localStorage project', () => {
    expect(resolveProjectId(PROJECTS, 'proj-2', 'proj-1')).toBe('proj-2');
  });

  it('matches case-insensitively by project id or project name', () => {
    expect(resolveProjectId(PROJECTS, 'PROJ-2', 'proj-1')).toBe('proj-2');
    expect(resolveProjectId(PROJECTS, 'beta mobile', 'proj-1')).toBe('proj-2');
    expect(resolveProjectId(PROJECTS, '  Demo Project ', 'proj-1')).toBe('proj-3');
  });

  it('falls back to saved project when ?project= is missing or unknown', () => {
    expect(resolveProjectId(PROJECTS, null, 'proj-3')).toBe('proj-3');
    expect(resolveProjectId(PROJECTS, 'unknown-proj', 'proj-3')).toBe('proj-3');
  });

  it('falls back to the first project when neither requested nor saved matches', () => {
    expect(resolveProjectId(PROJECTS, null, 'deleted-proj')).toBe('proj-1');
    expect(resolveProjectId(PROJECTS, 'unknown', null)).toBe('proj-1');
  });

  it('returns empty string when no projects exist', () => {
    expect(resolveProjectId([], 'proj-2', 'proj-1')).toBe('');
  });
});

describe('URL building and synchronization', () => {
  it('builds /app paths and full deep-link URLs', () => {
    expect(buildAppPathWithProject('proj-2')).toBe('/app?project=proj-2');
    expect(buildAppPathWithProject(null)).toBe('/app');
    expect(buildProjectDeepLink('https://gantt.example.com', 'proj-2')).toBe(
      'https://gantt.example.com/app?project=proj-2',
    );
    expect(buildProjectDeepLink('http://127.0.0.1:4173/', 'proj-2')).toBe('http://127.0.0.1:4173/app?project=proj-2');
  });

  it('synchronizes ?project= while preserving other search params and avoiding no-op updates', () => {
    const initial = new URLSearchParams('foo=bar');
    const updated = syncProjectQueryParam('proj-2', initial);
    expect(updated?.toString()).toBe('foo=bar&project=proj-2');

    // Already synchronized -> returns null
    expect(syncProjectQueryParam('proj-2', updated!)).toBeNull();

    // Switching projects updates only project param
    const switched = syncProjectQueryParam('proj-3', updated!);
    expect(switched?.toString()).toBe('foo=bar&project=proj-3');
  });
});

describe('OAuth deep-link preservation', () => {
  it('saves, peeks, consumes, and clears pending OAuth project in storage', () => {
    const storage = makeMemoryStorage();
    savePendingOAuthProject(' proj-2 ', storage);
    expect(peekPendingOAuthProject(storage)).toBe('proj-2');
    expect(consumePendingOAuthProject(storage)).toBe('proj-2');
    expect(peekPendingOAuthProject(storage)).toBeNull();

    savePendingOAuthProject('proj-3', storage);
    clearPendingOAuthProject(storage);
    expect(storage.getItem(OAUTH_PROJECT_STORAGE_KEY)).toBeNull();
  });

  it('builds GCP authorize URL with ?project= and saves it to storage', () => {
    const storage = makeMemoryStorage();
    expect(buildGcpLinearAuthorizeUrl('?project=proj-2', storage)).toBe('/api/linear/authorize?project=proj-2');
    expect(peekPendingOAuthProject(storage)).toBe('proj-2');

    // When URL lacks ?project=, reuses pending storage value if present
    expect(buildGcpLinearAuthorizeUrl('', storage)).toBe('/api/linear/authorize?project=proj-2');

    // Without either, returns plain authorize endpoint
    const emptyStorage = makeMemoryStorage();
    expect(buildGcpLinearAuthorizeUrl('', emptyStorage)).toBe('/api/linear/authorize');
  });

  it('resolves post-OAuth redirect path from search or consumed storage', () => {
    const storage = makeMemoryStorage({ [OAUTH_PROJECT_STORAGE_KEY]: 'proj-2' });
    expect(resolvePostOAuthRedirectPath('', storage)).toBe('/app?project=proj-2');
    // Storage entry was consumed
    expect(peekPendingOAuthProject(storage)).toBeNull();
    expect(resolvePostOAuthRedirectPath('', storage)).toBe('/app');
  });

  it('prefers explicit search ?project= over pending storage in post-OAuth redirect', () => {
    const storage = makeMemoryStorage({ [OAUTH_PROJECT_STORAGE_KEY]: 'proj-1' });
    expect(resolvePostOAuthRedirectPath('?project=proj-3', storage)).toBe('/app?project=proj-3');
  });
});
