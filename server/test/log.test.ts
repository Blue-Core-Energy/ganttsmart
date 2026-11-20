import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeError, log, writeLog } from '../src/log.js';

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
});
