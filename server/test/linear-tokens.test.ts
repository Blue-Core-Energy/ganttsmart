import { describe, expect, it } from 'vitest';
import { LinearReauthRequired, createLinearOAuth } from '../src/linear/oauth.js';
import { createTokenService } from '../src/linear/tokens.js';
import { createMemoryStore } from '../src/store/memory.js';
import type { LinearTokens, Store } from '../src/store/types.js';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const SUB = 'accounts.google.com:1';
const EMAIL = 'someone@bluecore.energy';

interface Reply {
  status: number;
  body: unknown;
}

/**
 * A stub Linear token endpoint. By default every refresh succeeds (even for a refresh token it
 * has already rotated, as Linear's 30-minute grace period allows) and returns a new numbered set.
 */
function stubLinear(reply?: () => Reply) {
  let issued = 0;
  const refreshTokensSeen: string[] = [];
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body));
    refreshTokensSeen.push(form.get('refresh_token') ?? '');
    // Yield so concurrent callers really overlap.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const r = reply?.() ?? {
      status: 200,
      body: { access_token: `access-${++issued}`, refresh_token: `refresh-${issued}`, expires_in: 86399 },
    };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof globalThis.fetch;
  const oauth = createLinearOAuth({
    clientId: 'id',
    clientSecret: 'secret',
    redirectUri: 'https://app.example.com/cb',
    fetch,
    now: () => NOW,
  });
  return { oauth, refreshTokensSeen };
}

async function storeWith(tokens: LinearTokens | null): Promise<Store> {
  const store = createMemoryStore();
  if (tokens) await store.saveTokens(SUB, EMAIL, tokens);
  return store;
}

const old = (expiresInMs: number | null): LinearTokens => ({
  accessToken: 'access-0',
  refreshToken: 'refresh-0',
  expiresAt: expiresInMs === null ? null : NOW + expiresInMs,
});

describe('createTokenService.getAccessToken', () => {
  it('returns a fresh token without calling Linear', async () => {
    const { oauth, refreshTokensSeen } = stubLinear();
    const store = await storeWith(old(60 * MINUTE));
    const tokens = createTokenService({ store, oauth, now: () => NOW });
    await expect(tokens.getAccessToken(SUB)).resolves.toBe('access-0');
    expect(refreshTokensSeen).toEqual([]);
  });

  it('treats a null expiresAt as non-expiring', async () => {
    const { oauth, refreshTokensSeen } = stubLinear();
    const store = await storeWith(old(null));
    const tokens = createTokenService({ store, oauth, now: () => NOW });
    await expect(tokens.getAccessToken(SUB)).resolves.toBe('access-0');
    expect(refreshTokensSeen).toEqual([]);
  });

  it('refreshes a token expiring in 4 minutes and stores the rotated tokens', async () => {
    const { oauth, refreshTokensSeen } = stubLinear();
    const store = await storeWith(old(4 * MINUTE));
    const tokens = createTokenService({ store, oauth, now: () => NOW });
    await expect(tokens.getAccessToken(SUB)).resolves.toBe('access-1');
    expect(refreshTokensSeen).toEqual(['refresh-0']);
    await expect(store.getTokens(SUB)).resolves.toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: NOW + 86399 * 1000,
    });
  });

  it('refreshes when forceRefresh is set', async () => {
    const { oauth, refreshTokensSeen } = stubLinear();
    const store = await storeWith(old(60 * MINUTE));
    const tokens = createTokenService({ store, oauth, now: () => NOW });
    await expect(tokens.getAccessToken(SUB, { forceRefresh: true })).resolves.toBe('access-1');
    expect(refreshTokensSeen).toEqual(['refresh-0']);
    expect((await store.getTokens(SUB))?.refreshToken).toBe('refresh-1');
  });

  it('throws LinearReauthRequired and clears the store on invalid_grant', async () => {
    const { oauth } = stubLinear(() => ({ status: 400, body: { error: 'invalid_grant' } }));
    const store = await storeWith(old(4 * MINUTE));
    const tokens = createTokenService({ store, oauth, now: () => NOW });
    await expect(tokens.getAccessToken(SUB)).rejects.toBeInstanceOf(LinearReauthRequired);
    await expect(store.getTokens(SUB)).resolves.toBeNull();
  });

  it.each([
    ['401 invalid_client', { status: 401, body: { error: 'invalid_client' } }],
    ['500', { status: 500, body: { error: 'server_error' } }],
  ])('throws a plain Error and leaves the store untouched on %s', async (_name, reply) => {
    const { oauth } = stubLinear(() => reply);
    const store = await storeWith(old(4 * MINUTE));
    const tokens = createTokenService({ store, oauth, now: () => NOW });
    const err = await tokens.getAccessToken(SUB).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LinearReauthRequired);
    await expect(store.getTokens(SUB)).resolves.toEqual(old(4 * MINUTE));
  });

  it('throws LinearReauthRequired when there are no tokens', async () => {
    const { oauth } = stubLinear();
    const store = await storeWith(null);
    const tokens = createTokenService({ store, oauth, now: () => NOW });
    await expect(tokens.getAccessToken(SUB)).rejects.toBeInstanceOf(LinearReauthRequired);
  });

  it('throws LinearReauthRequired and clears the store when an expiring token has no refresh token', async () => {
    const { oauth, refreshTokensSeen } = stubLinear();
    const store = await storeWith({ ...old(4 * MINUTE), refreshToken: null });
    const tokens = createTokenService({ store, oauth, now: () => NOW });
    await expect(tokens.getAccessToken(SUB)).rejects.toBeInstanceOf(LinearReauthRequired);
    await expect(store.getTokens(SUB)).resolves.toBeNull();
    expect(refreshTokensSeen).toEqual([]);
  });

  it('handles two simultaneous calls on an expiring token (Review Focus 2)', async () => {
    const { oauth } = stubLinear();
    const store = await storeWith(old(4 * MINUTE));
    const tokens = createTokenService({ store, oauth, now: () => NOW });

    const results = await Promise.all([tokens.getAccessToken(SUB), tokens.getAccessToken(SUB)]);

    const stored = await store.getTokens(SUB);
    expect(stored?.accessToken).toMatch(/^access-[1-9]$/);
    expect(stored?.refreshToken).toBe(stored?.accessToken.replace('access', 'refresh'));
    for (const token of results) expect(token).toMatch(/^access-[1-9]$/);
  });

  it('two service instances sharing a store converge on one rotated set', async () => {
    // Simulates two server instances: no shared in-flight state, so both call Linear (which
    // accepts the same refresh token twice) and swapTokens decides the winner.
    const { oauth, refreshTokensSeen } = stubLinear();
    const store = await storeWith(old(4 * MINUTE));
    const a = createTokenService({ store, oauth, now: () => NOW });
    const b = createTokenService({ store, oauth, now: () => NOW });

    const results = await Promise.all([a.getAccessToken(SUB), b.getAccessToken(SUB)]);

    expect(refreshTokensSeen).toEqual(['refresh-0', 'refresh-0']);
    const stored = await store.getTokens(SUB);
    expect(stored?.refreshToken).toBe(stored?.accessToken.replace('access', 'refresh'));
    // Both callers use the winner's access token.
    expect(results).toEqual([stored?.accessToken, stored?.accessToken]);
  });

  it('shares one in-flight refresh between concurrent calls in the same process', async () => {
    const { oauth, refreshTokensSeen } = stubLinear();
    const store = await storeWith(old(4 * MINUTE));
    const tokens = createTokenService({ store, oauth, now: () => NOW });

    const results = await Promise.all([tokens.getAccessToken(SUB), tokens.getAccessToken(SUB)]);

    expect(refreshTokensSeen).toEqual(['refresh-0']);
    expect(results).toEqual(['access-1', 'access-1']);
  });

  it('does not share an in-flight refresh across users', async () => {
    const { oauth, refreshTokensSeen } = stubLinear();
    const store = await storeWith(old(4 * MINUTE));
    await store.saveTokens('other', EMAIL, { ...old(4 * MINUTE), refreshToken: 'refresh-other' });
    const tokens = createTokenService({ store, oauth, now: () => NOW });

    await Promise.all([tokens.getAccessToken(SUB), tokens.getAccessToken('other')]);

    expect(refreshTokensSeen.sort()).toEqual(['refresh-0', 'refresh-other']);
  });
});
