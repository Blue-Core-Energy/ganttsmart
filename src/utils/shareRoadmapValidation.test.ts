import { describe, expect, it } from 'vitest';
import {
  canClaimRefresh,
  computeClientIpHash,
  extractClientIp,
  hashPasswordPBKDF2,
  isRateLimited,
  MAX_EXPIRY_DAYS,
  MAX_PASSWORD_ATTEMPTS,
  RATE_LIMIT_WINDOW_MS,
  STALE_TTL_MS,
  validateExpiresInDays,
  validatePassword,
  verifyPassword,
} from '../../supabase/functions/_shared/share-utils.ts';

describe('share-utils', () => {
  describe('validatePassword', () => {
    it('accepts valid string passwords up to 128 characters', () => {
      expect(validatePassword('secret123')).toEqual({ valid: true });
      expect(validatePassword('a'.repeat(128))).toEqual({ valid: true });
      expect(validatePassword('')).toEqual({ valid: true });
    });

    it('rejects passwords exceeding 128 characters', () => {
      const res = validatePassword('a'.repeat(129));
      expect(res.valid).toBe(false);
      expect(res.error).toMatch(/at most 128 characters/i);
    });

    it('rejects non-string values', () => {
      expect(validatePassword(12345).valid).toBe(false);
      expect(validatePassword(null).valid).toBe(false);
      expect(validatePassword(undefined).valid).toBe(false);
      expect(validatePassword({ password: 'foo' }).valid).toBe(false);
      expect(validatePassword(['pass']).valid).toBe(false);
      expect(validatePassword(true).valid).toBe(false);
    });
  });

  describe('validateExpiresInDays', () => {
    it('defaults to 3 days when omitted (undefined)', () => {
      expect(validateExpiresInDays(undefined)).toEqual({ valid: true, value: 3 });
    });

    it('rejects null explicitly', () => {
      const res = validateExpiresInDays(null);
      expect(res.valid).toBe(false);
      expect(res.error).toMatch(/expiresInDays must be an integer/i);
    });

    it('accepts valid integers between 1 and MAX_EXPIRY_DAYS (90)', () => {
      expect(validateExpiresInDays(1)).toEqual({ valid: true, value: 1 });
      expect(validateExpiresInDays(3)).toEqual({ valid: true, value: 3 });
      expect(validateExpiresInDays(MAX_EXPIRY_DAYS)).toEqual({ valid: true, value: MAX_EXPIRY_DAYS });
    });

    it('rejects values out of range', () => {
      expect(validateExpiresInDays(0).valid).toBe(false);
      expect(validateExpiresInDays(-5).valid).toBe(false);
      expect(validateExpiresInDays(MAX_EXPIRY_DAYS + 1).valid).toBe(false);
    });

    it('rejects non-integers and non-finite numbers', () => {
      expect(validateExpiresInDays(1.5).valid).toBe(false);
      expect(validateExpiresInDays(NaN).valid).toBe(false);
      expect(validateExpiresInDays(Infinity).valid).toBe(false);
    });

    it('rejects non-number types', () => {
      expect(validateExpiresInDays('3').valid).toBe(false);
      expect(validateExpiresInDays({ days: 3 }).valid).toBe(false);
      expect(validateExpiresInDays(true).valid).toBe(false);
    });
  });

  describe('extractClientIp', () => {
    it('prefers cf-connecting-ip', () => {
      const headers = new Headers({
        'cf-connecting-ip': '1.1.1.1',
        'x-real-ip': '2.2.2.2',
        'x-forwarded-for': '3.3.3.3, 4.4.4.4',
      });
      expect(extractClientIp(headers)).toBe('1.1.1.1');
    });

    it('prefers x-real-ip over x-forwarded-for when cf-connecting-ip is absent', () => {
      const headers = new Headers({
        'x-real-ip': '2.2.2.2',
        'x-forwarded-for': '3.3.3.3, 4.4.4.4',
      });
      expect(extractClientIp(headers)).toBe('2.2.2.2');
    });

    it('extracts rightmost IP from x-forwarded-for to prevent client header spoofing', () => {
      const headers = new Headers({
        'x-forwarded-for': 'spoofed.ip.attacker, 5.5.5.5, 6.6.6.6',
      });
      expect(extractClientIp(headers)).toBe('6.6.6.6');
    });

    it('handles trailing commas and spaces in x-forwarded-for cleanly', () => {
      const headers = new Headers({
        'x-forwarded-for': 'spoofed.ip.attacker, 5.5.5.5, 6.6.6.6,   ',
      });
      expect(extractClientIp(headers)).toBe('6.6.6.6');
    });

    it('falls back to unknown-client when no headers present', () => {
      const headers = new Headers();
      expect(extractClientIp(headers)).toBe('unknown-client');
    });
  });

  describe('isRateLimited', () => {
    const baseTime = 1700000000000;

    it('allows attempts within limit', () => {
      const res = isRateLimited(
        MAX_PASSWORD_ATTEMPTS,
        baseTime,
        MAX_PASSWORD_ATTEMPTS,
        RATE_LIMIT_WINDOW_MS,
        baseTime + 10000,
      );
      expect(res.blocked).toBe(false);
      expect(res.retryAfterSeconds).toBe(0);
    });

    it('blocks when attempt count exceeds limit within active window', () => {
      const now = baseTime + 30000; // 30s into 15m window (900s window)
      const res = isRateLimited(MAX_PASSWORD_ATTEMPTS + 1, baseTime, MAX_PASSWORD_ATTEMPTS, RATE_LIMIT_WINDOW_MS, now);
      expect(res.blocked).toBe(true);
      expect(res.retryAfterSeconds).toBe(870); // 900 - 30 = 870
    });

    it('unblocks when rate limit window expires', () => {
      const now = baseTime + RATE_LIMIT_WINDOW_MS + 1000;
      const res = isRateLimited(10, baseTime, MAX_PASSWORD_ATTEMPTS, RATE_LIMIT_WINDOW_MS, now);
      expect(res.blocked).toBe(false);
      expect(res.retryAfterSeconds).toBe(0);
    });
  });

  describe('canClaimRefresh', () => {
    const now = 1700000000000;

    it('does not claim if cache is fresh', () => {
      const freshCachedAt = now - (STALE_TTL_MS - 10000);
      expect(canClaimRefresh(freshCachedAt, null, STALE_TTL_MS, now)).toBe(false);
    });

    it('claims if cache is stale and no active lease exists', () => {
      const staleCachedAt = now - (STALE_TTL_MS + 1000);
      expect(canClaimRefresh(staleCachedAt, null, STALE_TTL_MS, now)).toBe(true);
    });

    it('does not claim if cache is stale but lease is currently held by another worker', () => {
      const staleCachedAt = now - (STALE_TTL_MS + 1000);
      const activeLease = now + 15000;
      expect(canClaimRefresh(staleCachedAt, activeLease, STALE_TTL_MS, now)).toBe(false);
    });

    it('claims if cache is stale and previous lease expired', () => {
      const staleCachedAt = now - (STALE_TTL_MS + 1000);
      const expiredLease = now - 1000;
      expect(canClaimRefresh(staleCachedAt, expiredLease, STALE_TTL_MS, now)).toBe(true);
    });

    it('claims if cache was never populated', () => {
      expect(canClaimRefresh(null, null, STALE_TTL_MS, now)).toBe(true);
    });
  });

  describe('password PBKDF2 hashing and verification', () => {
    it('hashes and successfully verifies a correct password', async () => {
      const password = 'SuperSecretPassword!2026';
      const hash = await hashPasswordPBKDF2(password);

      expect(hash.startsWith('pbkdf2:')).toBe(true);
      expect(hash.split(':')).toHaveLength(3);

      const isValid = await verifyPassword(password, hash);
      expect(isValid).toBe(true);
    });

    it('rejects an incorrect password', async () => {
      const password = 'CorrectPassword';
      const hash = await hashPasswordPBKDF2(password);

      const isValid = await verifyPassword('WrongPassword', hash);
      expect(isValid).toBe(false);
    });

    it('rejects legacy static-salt SHA-256 hashes (dropped in IT-153)', async () => {
      const legacyHash = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const isValid = await verifyPassword('mypassword', legacyHash);
      expect(isValid).toBe(false);
    });

    it('rejects malformed hash formats', async () => {
      expect(await verifyPassword('foo', 'pbkdf2:incomplete')).toBe(false);
      expect(await verifyPassword('foo', 'pbkdf2::')).toBe(false);
      expect(await verifyPassword('foo', '')).toBe(false);
    });
  });

  describe('computeClientIpHash', () => {
    it('produces a deterministic SHA-256 hex digest', async () => {
      const hash1 = await computeClientIpHash('192.168.1.100');
      const hash2 = await computeClientIpHash('192.168.1.100');
      const hash3 = await computeClientIpHash('10.0.0.1');

      expect(hash1).toHaveLength(64);
      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(hash3);
    });

    it('handles empty string gracefully', async () => {
      const hash = await computeClientIpHash('');
      expect(hash).toHaveLength(64);
    });
  });
});
