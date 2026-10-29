import type { LinearTokens } from '../store/types.js';

const AUTHORIZE_URL = 'https://linear.app/oauth/authorize';
const TOKEN_URL = 'https://api.linear.app/oauth/token';
const REVOKE_URL = 'https://api.linear.app/oauth/revoke';
const SCOPE = 'read,write';
const TIMEOUT_MS = 10_000;

/**
 * Linear rejected the refresh token (`invalid_grant`): the user must connect Linear again. Other
 * failures (a wrong client secret, a Linear outage) are plain Errors so they never disconnect users.
 */
export class LinearReauthRequired extends Error {
  constructor(message = 'Linear authorization expired; reconnect Linear') {
    super(message);
    this.name = 'LinearReauthRequired';
  }
}

export interface LinearOAuth {
  authorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<LinearTokens>;
  /** Throws LinearReauthRequired only when Linear answers `invalid_grant`. */
  refresh(refreshToken: string): Promise<LinearTokens>;
  /** Best effort; never throws. */
  revoke(token: string): Promise<void>;
}

export interface LinearOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: typeof fetch;
  now?: () => number;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function field(body: unknown, name: string): unknown {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : undefined;
}

/** The OAuth `error` code, if it looks like one. Safe to put in messages: it never holds secrets. */
function errorCode(body: unknown): string | null {
  const code = field(body, 'error');
  return typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? code : null;
}

export function createLinearOAuth(cfg: LinearOAuthConfig): LinearOAuth {
  const doFetch = cfg.fetch ?? globalThis.fetch;
  const now = cfg.now ?? Date.now;

  function post(url: string, form: Record<string, string>): Promise<Response> {
    return doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  /** Posts to the token endpoint. Errors name the grant and status, never token values. */
  async function requestTokens(grant: 'authorization_code' | 'refresh_token', form: Record<string, string>) {
    let res: Response;
    try {
      res = await post(TOKEN_URL, {
        grant_type: grant,
        ...form,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.name : 'unknown error';
      throw new Error(`Linear token request (${grant}) failed: ${reason}`);
    }
    const body = parseJson(await res.text().catch(() => ''));

    if (!res.ok) {
      const code = errorCode(body);
      if (grant === 'refresh_token' && (res.status === 400 || res.status === 401) && code === 'invalid_grant') {
        throw new LinearReauthRequired();
      }
      throw new Error(`Linear token request (${grant}) failed: HTTP ${res.status}${code ? ` ${code}` : ''}`);
    }

    const accessToken = field(body, 'access_token');
    if (typeof accessToken !== 'string' || accessToken === '') {
      throw new Error(`Linear token request (${grant}) returned no access token`);
    }
    const refreshToken = field(body, 'refresh_token');
    const expiresIn = field(body, 'expires_in');
    return {
      accessToken,
      refreshToken: typeof refreshToken === 'string' && refreshToken !== '' ? refreshToken : null,
      expiresAt: typeof expiresIn === 'number' && Number.isFinite(expiresIn) ? now() + expiresIn * 1000 : null,
    };
  }

  return {
    authorizeUrl(state) {
      const params = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: cfg.redirectUri,
        response_type: 'code',
        scope: SCOPE,
        state,
      });
      return `${AUTHORIZE_URL}?${params.toString()}`;
    },

    exchangeCode(code) {
      return requestTokens('authorization_code', { code, redirect_uri: cfg.redirectUri });
    },

    refresh(refreshToken) {
      return requestTokens('refresh_token', { refresh_token: refreshToken });
    },

    async revoke(token) {
      try {
        await post(REVOKE_URL, { token });
      } catch {
        // Best effort: the caller clears its own copy regardless.
      }
    },
  };
}
