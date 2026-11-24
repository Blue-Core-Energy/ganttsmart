import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

describe('supabase backend capabilities', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('configures standard login capabilities when VITE_AUTH_MODE is unset', async () => {
    const { backend } = await import('./index');
    expect(backend.capabilities).toMatchObject({
      passwordLogin: true,
      keycloakLogin: false,
    });
  });

  it('configures standard login capabilities when VITE_AUTH_MODE is standard', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'standard');
    const { backend } = await import('./index');
    expect(backend.capabilities).toMatchObject({
      passwordLogin: true,
      keycloakLogin: false,
    });
  });

  it('configures keycloak login capabilities when VITE_AUTH_MODE is keycloak', async () => {
    vi.stubEnv('VITE_AUTH_MODE', 'keycloak');
    const { backend } = await import('./index');
    expect(backend.capabilities).toMatchObject({
      passwordLogin: false,
      keycloakLogin: true,
    });
  });
});
