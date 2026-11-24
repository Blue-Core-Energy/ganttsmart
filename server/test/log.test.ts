import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeError, log, redactSensitive, redactUrl, writeLog } from '../src/log.js';

function captureStdout() {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  });
  return {
    spy,
    entries: () => lines.map((line) => JSON.parse(line.trimEnd()) as Record<string, unknown>),
    raw: () => lines,
  };
}

describe('log', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes single-line JSON entries with Cloud Logging severities', () => {
    const out = captureStdout();

    log.info('server started', { mode: 'iap', port: 8080 });
    log.warn('IAP identity check failed', { error: { name: 'UnauthorizedError' } });
    log.error('Request failed', { status: 500 });

    expect(out.raw()).toHaveLength(3);
    for (const line of out.raw()) {
      expect(line.endsWith('\n')).toBe(true);
      expect(line.slice(0, -1)).not.toContain('\n');
    }

    expect(out.entries()).toEqual([
      { severity: 'INFO', message: 'server started', mode: 'iap', port: 8080 },
      { severity: 'WARNING', message: 'IAP identity check failed', error: { name: 'UnauthorizedError' } },
      { severity: 'ERROR', message: 'Request failed', status: 500 },
    ]);
  });

  it('prevents caller fields from overwriting severity or message and skips undefined values', () => {
    const out = captureStdout();

    writeLog('ERROR', 'real message', {
      severity: 'INFO',
      message: 'spoofed',
      code: 'ECONNREFUSED',
      omitted: undefined,
    });

    expect(out.entries()).toEqual([{ severity: 'ERROR', message: 'real message', code: 'ECONNREFUSED' }]);
  });
});

describe('describeError', () => {
  it('captures name, message, code, and one level of cause without stack traces', () => {
    const cause = Object.assign(new Error('deadline exceeded'), { code: 'ETIMEDOUT' });
    const err = Object.assign(new Error('firestore unavailable', { cause }), { code: 4 });
    err.stack = 'Error: firestore unavailable\n    at secret-internal-stack';

    const described = describeError(err);
    expect(described).toEqual({
      name: 'Error',
      message: 'firestore unavailable',
      code: 4,
      cause: {
        name: 'Error',
        message: 'deadline exceeded',
        code: 'ETIMEDOUT',
      },
    });
    expect(JSON.stringify(described)).not.toContain('secret-internal-stack');
  });

  it('handles non-Error thrown values safely without leaking the value', () => {
    expect(describeError('secret-token-string')).toEqual({ error: 'string' });
    expect(describeError(null)).toEqual({ error: 'object' });
  });

  it('redacts bearer tokens and secret query params from error messages and causes', () => {
    const cause = new Error(
      'request to https://api.linear.app/oauth/token?client_secret=supersecret&code=oauthcode failed',
    );
    const err = new Error('authorization failed: Bearer secret-bearer-token-12345', { cause });

    const described = describeError(err);
    expect(described.message).toBe('authorization failed: Bearer [REDACTED]');
    expect(described.cause?.message).toBe(
      'request to https://api.linear.app/oauth/token?client_secret=%5BREDACTED%5D&code=%5BREDACTED%5D failed',
    );
    expect(JSON.stringify(described)).not.toContain('secret-bearer-token-12345');
    expect(JSON.stringify(described)).not.toContain('supersecret');
    expect(JSON.stringify(described)).not.toContain('oauthcode');
  });
});

describe('redactUrl and redactSensitive', () => {
  it('redacts sensitive query params and credentials in URLs', () => {
    const raw = 'https://admin:pass123@example.com/callback?code=abc&state=xyz&token=secret&safe=hello';
    const redacted = redactUrl(raw);
    expect(redacted).not.toContain('pass123');
    expect(redacted).not.toContain('abc');
    expect(redacted).not.toContain('xyz');
    expect(redacted).not.toContain('secret');
    expect(redacted).toContain('safe=hello');
  });

  it('redacts relative URLs and hash fragments with sensitive parameters', () => {
    const relativeUrl = '/api/linear/callback?code=secret_code&state=secret_state&safe=1';
    expect(redactUrl(relativeUrl)).toBe('/api/linear/callback?code=%5BREDACTED%5D&state=%5BREDACTED%5D&safe=1');

    const withHash = 'https://example.com/callback#access_token=secret_tok&token_type=bearer';
    expect(redactUrl(withHash)).toContain('access_token=%5BREDACTED%5D');
    expect(redactUrl(withHash)).not.toContain('secret_tok');

    const inText = 'Redirected to /api/linear/callback?code_verifier=secret_verifier&id_token=secret_id in handler';
    const textRedacted = redactSensitive(inText);
    expect(textRedacted).not.toContain('secret_verifier');
    expect(textRedacted).not.toContain('secret_id');
  });

  it('redacts Bearer tokens in text', () => {
    const text = 'Failed with header Authorization: Bearer lin_oauth_12345abcde and extra text';
    expect(redactSensitive(text)).toBe('Failed with header Authorization: Bearer [REDACTED] and extra text');
  });

  it('redacts sensitive keys and values in writeLog messages and fields', () => {
    const out = captureStdout();
    log.error('Failed with Bearer secret-tok-999', {
      url: 'https://linear.app/oauth?client_secret=secret1&code=c1',
      accessToken: 'raw-access-token',
      refreshToken: 'raw-refresh-token',
      password: 'user-pass',
      clientSecret: 'secret-key-value',
      nested: { token: 'Bearer inner-token' },
    });

    const entry = out.entries()[0];
    expect(entry.message).toBe('Failed with Bearer [REDACTED]');
    expect(entry.accessToken).toBe('[REDACTED]');
    expect(entry.refreshToken).toBe('[REDACTED]');
    expect(entry.password).toBe('[REDACTED]');
    expect(entry.clientSecret).toBe('[REDACTED]');
    expect(JSON.stringify(entry)).not.toContain('secret-tok-999');
    expect(JSON.stringify(entry)).not.toContain('secret1');
    expect(JSON.stringify(entry)).not.toContain('c1');
    expect(JSON.stringify(entry)).not.toContain('raw-access-token');
    expect(JSON.stringify(entry)).not.toContain('raw-refresh-token');
    expect(JSON.stringify(entry)).not.toContain('user-pass');
    expect(JSON.stringify(entry)).not.toContain('inner-token');
  });

  it('handles Date, Error, and circular objects in fields without crashing', () => {
    const out = captureStdout();
    const circular: Record<string, unknown> = { name: 'test' };
    circular.self = circular;

    const date = new Date('2026-01-01T00:00:00.000Z');
    const innerError = new Error('nested failure: Bearer token123');

    log.warn('Testing special fields', {
      timestamp: date,
      cause: innerError,
      circular,
    });

    const entry = out.entries()[0];
    expect(entry.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(entry.cause).toEqual({
      name: 'Error',
      message: 'nested failure: Bearer [REDACTED]',
    });
    expect((entry.circular as Record<string, unknown>).self).toBe('[Circular]');
  });
});
