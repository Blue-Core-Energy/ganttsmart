import type { LinearTokens, Store } from '../store/types.js';
import { LinearReauthRequired, type LinearOAuth } from './oauth.js';

/** Refresh when the access token has less than this long left. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export interface TokenService {
  /**
   * The user's Linear access token, refreshed first if it expires within 5 minutes or
   * `forceRefresh` is set. Throws LinearReauthRequired (after clearing the stored tokens) when the
   * user is not connected or Linear rejected the refresh token; other failures are plain Errors
   * and leave the stored tokens alone.
   */
  getAccessToken(sub: string, opts?: { forceRefresh?: boolean }): Promise<string>;
}

export function createTokenService(deps: { store: Store; oauth: LinearOAuth; now?: () => number }): TokenService {
  const { store, oauth } = deps;
  const now = deps.now ?? Date.now;
  // One refresh per user at a time in this process. Across instances, swapTokens plus Linear's
  // 30-minute grace period for the previous refresh token keep concurrent refreshes safe.
  const inFlight = new Map<string, Promise<string>>();

  async function reauth(sub: string): Promise<never> {
    await store.clearTokens(sub);
    throw new LinearReauthRequired();
  }

  async function refresh(sub: string, refreshToken: string): Promise<string> {
    let next: LinearTokens;
    try {
      next = await oauth.refresh(refreshToken);
    } catch (err) {
      if (!(err instanceof LinearReauthRequired)) throw err;
      // Another instance may have rotated the tokens after we read them; use theirs if so.
      const current = await store.getTokens(sub);
      if (current && current.refreshToken !== refreshToken) return current.accessToken;
      return reauth(sub);
    }
    // Linear rotates refresh tokens; if a response ever omits one, keep using the old one.
    const saved = await store.swapTokens(sub, refreshToken, {
      ...next,
      refreshToken: next.refreshToken ?? refreshToken,
    });
    return saved.accessToken;
  }

  return {
    async getAccessToken(sub, opts) {
      const pending = inFlight.get(sub);
      if (pending) return pending;

      const tokens = await store.getTokens(sub);
      if (!tokens) return reauth(sub);

      const expiring = tokens.expiresAt !== null && tokens.expiresAt - now() < REFRESH_MARGIN_MS;
      if (!opts?.forceRefresh && !expiring) return tokens.accessToken;
      if (tokens.refreshToken === null) return reauth(sub);

      // Re-check: another call may have started a refresh while we awaited the store.
      const raced = inFlight.get(sub);
      if (raced) return raced;
      const promise = refresh(sub, tokens.refreshToken).finally(() => inFlight.delete(sub));
      inFlight.set(sub, promise);
      return promise;
    },
  };
}
