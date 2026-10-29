import { describe, expect, it } from 'vitest';
import { readLinearError } from './linearError';

describe('readLinearError', () => {
  it('maps access_denied to a cancellation message', () => {
    expect(readLinearError('?linear_error=access_denied')).toBe('Linear connection was cancelled.');
  });

  it('asks the user to try again for other codes', () => {
    expect(readLinearError('?linear_error=invalid_state')).toMatch(/please try again/i);
    expect(readLinearError('?linear_error=exchange_failed')).toMatch(/please try again/i);
  });

  it('returns null when there is no linear_error', () => {
    expect(readLinearError('')).toBeNull();
    expect(readLinearError('?foo=bar')).toBeNull();
  });
});
