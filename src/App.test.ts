import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '@/App';
import { UNREACHABLE_MESSAGE } from '@/backend/gcp/sessionError';

const { authState, backendMock } = vi.hoisted(() => {
  const authState = {
    user: null,
    loading: false,
    linearToken: null,
    linearError: null,
    signedOutMessage: null as string | null,
    connectLinear: vi.fn(),
    signUp: vi.fn(),
    signIn: vi.fn(),
    signInWithGoogle: vi.fn(),
    signInWithKeycloak: vi.fn(),
    signOut: vi.fn(),
    refreshLinearToken: vi.fn(),
    disconnectLinear: vi.fn(),
  };

  const backendMock = {
    kind: 'gcp',
    capabilities: {
      sharing: false,
      passwordLogin: false,
      marketingPages: false,
      sharedDaysOff: true,
      signOut: true,
      keycloakLogin: false,
    },
    useAuth: () => authState,
  };

  return { authState, backendMock };
});

vi.mock('@/backend', () => ({
  backend: backendMock,
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => authState,
}));

describe('App', () => {
  beforeEach(() => {
    backendMock.capabilities.keycloakLogin = false;
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
      location: { reload: vi.fn() },
    });
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: vi.fn(),
    });
    vi.stubGlobal('document', {
      documentElement: { classList: { remove: vi.fn(), add: vi.fn() } },
    });
  });

  afterEach(() => {
    backendMock.capabilities.keycloakLogin = false;
    vi.unstubAllGlobals();
  });

  it('renders SessionExpired with "Couldn\'t reach GanttSmart" when signedOutMessage is set', () => {
    authState.loading = false;
    authState.user = null;
    authState.signedOutMessage = UNREACHABLE_MESSAGE;

    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain('Couldn&#x27;t reach GanttSmart. Check your connection and reload.');
    expect(html).toContain('Reload');
  });

  it('renders SessionExpired with default session expired message when signedOutMessage is null', () => {
    authState.loading = false;
    authState.user = null;
    authState.signedOutMessage = null;

    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain('Your session expired. Reload to sign in again.');
    expect(html).toContain('Reload');
  });

  it('renders KeycloakAuthPage when backend.capabilities.keycloakLogin is true and user is null', () => {
    authState.loading = false;
    authState.user = null;
    backendMock.capabilities.keycloakLogin = true;

    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain('Continue with Keycloak');
    expect(html).toContain('Sign in to your account.');
    expect(html).not.toContain('Continue with Google');
    expect(html).not.toContain('Create an account to get started');
  });
});
