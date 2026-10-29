import { describe, expect, it } from 'vitest';
import { LinearReauthRequired, createLinearOAuth } from '../src/linear/oauth.js';

const NOW = 1_800_000_000_000;

interface Call {
  url: string;
  method: string | undefined;
  contentType: string | null;
  form: URLSearchParams;
}

/** A stub fetch that records each call and replies with the given status and body. */
function stubFetch(status: number, body: unknown) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      contentType: new Headers(init?.headers).get('content-type'),
      form: new URLSearchParams(String(init?.body)),
    });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function oauth(fetch: typeof globalThis.fetch) {
  return createLinearOAuth({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://app.example.com/api/linear/callback',
    fetch,
    now: () => NOW,
  });
}

describe('createLinearOAuth', () => {
  it('builds the authorize URL', () => {
    const url = new URL(oauth(stubFetch(200, {}).fetch).authorizeUrl('state-123'));
    expect(url.origin + url.pathname).toBe('https://linear.app/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'client-id',
      redirect_uri: 'https://app.example.com/api/linear/callback',
      response_type: 'code',
      scope: 'read,write',
      state: 'state-123',
    });
  });

  it('exchangeCode posts an authorization_code form and maps expires_in to expiresAt', async () => {
    const { fetch, calls } = stubFetch(200, {
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 86399,
      token_type: 'Bearer',
    });
    await expect(oauth(fetch).exchangeCode('the-code')).resolves.toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: NOW + 86399 * 1000,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.linear.app/oauth/token');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].contentType).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(calls[0].form)).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: 'https://app.example.com/api/linear/callback',
      client_id: 'client-id',
      client_secret: 'client-secret',
    });
  });

  it('exchangeCode gives null expiresAt and refreshToken when Linear omits them', async () => {
    const { fetch } = stubFetch(200, { access_token: 'access-1' });
    await expect(oauth(fetch).exchangeCode('c')).resolves.toEqual({
      accessToken: 'access-1',
      refreshToken: null,
      expiresAt: null,
    });
  });

  it('exchangeCode throws a plain Error on failure', async () => {
    const { fetch } = stubFetch(400, { error: 'invalid_grant' });
    const err = await oauth(fetch)
      .exchangeCode('bad-code')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LinearReauthRequired);
    expect((err as Error).message).not.toContain('bad-code');
  });

  it('refresh posts a refresh_token form and returns the rotated refresh token', async () => {
    const { fetch, calls } = stubFetch(200, {
      access_token: 'access-2',
      refresh_token: 'refresh-2',
      expires_in: 86399,
    });
    await expect(oauth(fetch).refresh('refresh-1')).resolves.toEqual({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      expiresAt: NOW + 86399 * 1000,
    });
    expect(calls[0].url).toBe('https://api.linear.app/oauth/token');
    expect(calls[0].contentType).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(calls[0].form)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
      client_id: 'client-id',
      client_secret: 'client-secret',
    });
  });

  it('refresh on 400 invalid_grant throws LinearReauthRequired', async () => {
    const { fetch } = stubFetch(400, { error: 'invalid_grant' });
    await expect(oauth(fetch).refresh('refresh-1')).rejects.toBeInstanceOf(LinearReauthRequired);
  });

  it('refresh on 401 invalid_grant throws LinearReauthRequired', async () => {
    const { fetch } = stubFetch(401, { error: 'invalid_grant' });
    await expect(oauth(fetch).refresh('refresh-1')).rejects.toBeInstanceOf(LinearReauthRequired);
  });

  it.each([
    ['401 invalid_client', 401, { error: 'invalid_client' }],
    ['400 invalid_request', 400, { error: 'invalid_request' }],
    ['500', 500, { error: 'server_error' }],
    ['400 with a non-JSON body', 400, '<html>Bad Request</html>'],
    ['200 with a non-JSON body', 200, 'not json'],
    ['200 without an access token', 200, { refresh_token: 'refresh-2' }],
  ])('refresh on %s throws a plain Error without token values', async (_name, status, body) => {
    const { fetch } = stubFetch(status, body);
    const err = await oauth(fetch)
      .refresh('secret-refresh-token')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LinearReauthRequired);
    expect((err as Error).message).not.toContain('secret-refresh-token');
    expect((err as Error).message).not.toContain('client-secret');
  });

  it('revoke posts the form field token', async () => {
    const { fetch, calls } = stubFetch(200, {});
    await oauth(fetch).revoke('access-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.linear.app/oauth/revoke');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].contentType).toBe('application/x-www-form-urlencoded');
    expect(calls[0].form.get('token')).toBe('access-1');
  });

  it('revoke swallows a 400', async () => {
    const { fetch } = stubFetch(400, { error: 'invalid_request' });
    await expect(oauth(fetch).revoke('access-1')).resolves.toBeUndefined();
  });

  it('revoke swallows a network error', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof globalThis.fetch;
    await expect(oauth(fetch).revoke('access-1')).resolves.toBeUndefined();
  });
});
