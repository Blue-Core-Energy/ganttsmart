import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearLinearTokensCas,
  LinearReauthRequired,
  refreshLinearToken,
  rotateLinearTokensWithCas,
} from '../../../supabase/functions/_shared/linear-token';

type MockSupabase = Parameters<typeof rotateLinearTokensWithCas>[0];

describe('linear-token CAS rotation and clearing', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  describe('rotateLinearTokensWithCas', () => {
    it('returns new accessToken and expiresAt when status is rotated', async () => {
      const rpc = vi.fn().mockResolvedValue({
        data: [{ status: 'rotated', access_token: 'new-at', expires_at: '2026-11-24T12:00:00Z' }],
        error: null,
      });
      const supabase = { rpc } as unknown as MockSupabase;

      const res = await rotateLinearTokensWithCas(supabase, 'u1', 'old-rt', {
        access_token: 'new-at',
        refresh_token: 'new-rt',
        expires_in: 3600,
      });

      expect(res.accessToken).toBe('new-at');
      expect(res.expiresAt).toBeTruthy();
      expect(rpc).toHaveBeenCalledWith('rotate_linear_tokens', {
        p_user_id: 'u1',
        p_old_refresh_token: 'old-rt',
        p_new_access_token: 'new-at',
        p_new_refresh_token: 'new-rt',
        p_token_type: 'Bearer',
        p_expires_at: expect.any(String),
      });
      // Does not revoke any tokens
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('handles conflict: returns currently stored tokens without revoking sibling tokens', async () => {
      const rpc = vi.fn().mockResolvedValue({
        data: [{ status: 'conflict', access_token: 'stored-sibling-at', expires_at: '2026-11-24T18:00:00Z' }],
        error: null,
      });
      const supabase = { rpc } as unknown as MockSupabase;

      const res = await rotateLinearTokensWithCas(supabase, 'u1', 'old-rt', {
        access_token: 'orphaned-new-at',
        refresh_token: 'orphaned-new-rt',
      });

      expect(res.accessToken).toBe('stored-sibling-at');
      expect(res.expiresAt).toBe('2026-11-24T18:00:00.000Z');
      // Crucial: Must NOT have called Linear /oauth/revoke for sibling or new tokens!
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('handles missing (disconnected): revokes orphaned new tokens and throws LinearReauthRequired', async () => {
      const rpc = vi.fn().mockResolvedValue({
        data: [{ status: 'missing', access_token: null, expires_at: null }],
        error: null,
      });
      const supabase = { rpc } as unknown as MockSupabase;
      fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));

      await expect(
        rotateLinearTokensWithCas(supabase, 'u1', 'old-rt', {
          access_token: 'orphaned-new-at',
          refresh_token: 'orphaned-new-rt',
        }),
      ).rejects.toBeInstanceOf(LinearReauthRequired);

      // Best-effort revocation of orphaned newly-minted tokens
      expect(fetchMock).toHaveBeenCalledWith('https://api.linear.app/oauth/revoke', expect.any(Object));
    });

    it('fails loudly on RPC database error', async () => {
      const rpc = vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'connection failure' },
      });
      const supabase = { rpc } as unknown as MockSupabase;

      await expect(
        rotateLinearTokensWithCas(supabase, 'u1', 'old-rt', {
          access_token: 'new-at',
        }),
      ).rejects.toThrow('Database error during token rotation: connection failure');
    });
  });

  describe('clearLinearTokensCas', () => {
    it('returns true when row was matched and deleted', async () => {
      const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
      const supabase = { rpc } as unknown as MockSupabase;

      const cleared = await clearLinearTokensCas(supabase, 'u1', 'old-rt');
      expect(cleared).toBe(true);
      expect(rpc).toHaveBeenCalledWith('clear_linear_tokens_cas', {
        p_user_id: 'u1',
        p_old_refresh_token: 'old-rt',
      });
    });

    it('returns false when refresh token did not match', async () => {
      const rpc = vi.fn().mockResolvedValue({ data: false, error: null });
      const supabase = { rpc } as unknown as MockSupabase;

      const cleared = await clearLinearTokensCas(supabase, 'u1', 'old-rt');
      expect(cleared).toBe(false);
    });

    it('fails loudly on database error', async () => {
      const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'timeout' } });
      const supabase = { rpc } as unknown as MockSupabase;

      await expect(clearLinearTokensCas(supabase, 'u1', 'old-rt')).rejects.toThrow(
        'Database error during token clear: timeout',
      );
    });
  });

  describe('refreshLinearToken on invalid_grant', () => {
    it('returns fresh tokens if another worker rotated while refresh was in flight', async () => {
      const rtMaybeSingle = vi
        .fn()
        // First call: returns 'stale-rt'
        .mockResolvedValueOnce({ data: { refresh_token: 'stale-rt' }, error: null })
        // Second call after CAS failed: returns 'concurrent-fresh-rt'
        .mockResolvedValueOnce({ data: { refresh_token: 'concurrent-fresh-rt' }, error: null });

      const settingsMaybeSingle = vi.fn().mockResolvedValueOnce({
        data: {
          linear_access_token: 'fresh-at',
          linear_token_expires_at: '2026-11-24T15:00:00Z',
        },
        error: null,
      });

      const from = vi.fn((table: string) => {
        if (table === 'linear_refresh_tokens') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: rtMaybeSingle,
              }),
            }),
          };
        }
        if (table === 'user_settings') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: settingsMaybeSingle,
              }),
            }),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      });

      // CAS clear returns false (token was already modified)
      const rpc = vi.fn().mockResolvedValue({ data: false, error: null });
      const supabase = { from, rpc } as unknown as MockSupabase;

      // Linear token refresh fails with invalid_grant
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const result = await refreshLinearToken(supabase, 'u1');
      expect(result.accessToken).toBe('fresh-at');
      expect(result.expiresAt).toBe('2026-11-24T15:00:00.000Z');
    });

    it('throws LinearReauthRequired when tokens were genuinely revoked and cleared', async () => {
      const from = vi.fn(() => ({
        select: () => ({
          eq: () => ({
            maybeSingle: vi.fn().mockResolvedValue({ data: { refresh_token: 'revoked-rt' }, error: null }),
          }),
        }),
      }));

      // CAS clear successfully cleared the matching token
      const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
      const supabase = { from, rpc } as unknown as MockSupabase;

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      await expect(refreshLinearToken(supabase, 'u1')).rejects.toBeInstanceOf(LinearReauthRequired);
    });
  });
});
