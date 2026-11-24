import type { LinearTokens, Store } from '../store/types.js';
import { LinearReauthRequired, type LinearOAuth } from './oauth.js';

/** Refresh when the access token has less than this long left. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export interface TokenSnapshot {
  accessToken: string;
  refreshToken: string | null;
}

export interface TokenService {
  /**
   * The user's Linear access token, refreshed first if it expires within 5 minutes or
   * `forceRefresh` is set. Throws LinearReauthRequired (after clearing the stored tokens) when the
   * user is not connected or Linear rejected the refresh token; other failures are plain Errors
   * and leave the stored tokens alone.
   */
  getAccessToken(sub: string, opts?: { forceRefresh?: boolean; rejectedToken?: string }): Promise<string>;
  getTokenSnapshot(sub: string, opts?: { forceRefresh?: boolean; rejectedToken?: string }): Promise<TokenSnapshot>;
}

export function createTokenService(deps: { store: Store; oauth: LinearOAuth; now?: () => number }): TokenService {
  const { store, oauth } = deps;
  const now = deps.now ?? Date.now;
  // One refresh per user at a time in this process. Across instances, swapTokens plus Linear's
  // 30-minute grace period for the previous refresh token keep concurrent refreshes safe.
  const inFlight = new Map<string, Promise<TokenSnapshot>>();

  async function refresh(sub: string, refreshToken: string): Promise<TokenSnapshot> {
    let next: LinearTokens;
    try {
      next = await oauth.refresh(refreshToken);
    } catch (err) {
      if (!(err instanceof LinearReauthRequired)) throw err;
      // Conditionally clear tokens only if the stored refresh token still matches the one that failed.
      // If a concurrent reconnect or another rotation already updated it, do not wipe out the new tokens.
      const cleared = await store.clearTokens(sub, refreshToken);
      if (!cleared) {
        const current = await store.getTokens(sub);
        if (current && current.refreshToken !== refreshToken) {
          return { accessToken: current.accessToken, refreshToken: current.refreshToken };
        }
      }
      throw new LinearReauthRequired();
    }
    // Linear rotates refresh tokens; if a response ever omits one, keep using the old one.
    const saved = await store.swapTokens(sub, refreshToken, {
      ...next,
      refreshToken: next.refreshToken ?? refreshToken,
    });
    if (saved === null) {
      // User disconnected while refresh was in flight; revoke the orphaned grant.
      await Promise.allSettled([
        oauth.revoke(next.accessToken),
        next.refreshToken !== null ? oauth.revoke(next.refreshToken) : undefined,
      ]);
      throw new LinearReauthRequired();
    }
    return { accessToken: saved.accessToken, refreshToken: saved.refreshToken };
  }

  /**
   * Joins a refresh already in flight. If it yields the token the caller just had rejected, retries
   * once without `rejectedToken` and with a forced refresh, so waiters don't cascade into repeated retries.
   */
  async function joinRefresh(
    sub: string,
    promise: Promise<TokenSnapshot>,
    opts?: { forceRefresh?: boolean; rejectedToken?: string },
  ): Promise<TokenSnapshot> {
    const snapshot = await promise;
    if (opts?.rejectedToken && snapshot.accessToken === opts.rejectedToken) {
      return service.getTokenSnapshot(sub, { forceRefresh: true });
    }
    return snapshot;
  }

  const service: TokenService = {
    async getAccessToken(sub, opts) {
      const snapshot = await service.getTokenSnapshot(sub, opts);
      return snapshot.accessToken;
    },

    async getTokenSnapshot(sub, opts) {
      const pending = inFlight.get(sub);
      if (pending) {
        return joinRefresh(sub, pending, opts);
      }

      const tokens = await store.getTokens(sub);
      // Not connected (or disconnected meanwhile): don't clear, a concurrent reconnect must survive.
      if (!tokens) throw new LinearReauthRequired();

      const rejected = opts?.rejectedToken !== undefined && tokens.accessToken === opts.rejectedToken;
      const expiring = tokens.expiresAt !== null && tokens.expiresAt - now() < REFRESH_MARGIN_MS;
      if (!opts?.forceRefresh && !expiring && !rejected) {
        return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
      }
      if (tokens.refreshToken === null) {
        const cleared = await store.clearTokens(sub, { refreshToken: null, accessToken: tokens.accessToken });
        if (!cleared) {
          const current = await store.getTokens(sub);
          if (current && (current.refreshToken !== null || current.accessToken !== tokens.accessToken)) {
            return { accessToken: current.accessToken, refreshToken: current.refreshToken };
          }
        }
        throw new LinearReauthRequired();
      }

      // Re-check: another call may have started a refresh while we awaited the store.
      const raced = inFlight.get(sub);
      if (raced) {
        return joinRefresh(sub, raced, opts);
      }
      const promise = refresh(sub, tokens.refreshToken).finally(() => inFlight.delete(sub));
      inFlight.set(sub, promise);
      return promise;
    },
  };

  return service;
}
