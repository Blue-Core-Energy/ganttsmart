import { describe, expect, it } from 'vitest';
import { SessionExpiredError } from './api';
import { sessionErrorMessage, UNREACHABLE_MESSAGE } from './sessionError';

describe('sessionErrorMessage', () => {
  it('uses the default "session expired" screen (null) for SessionExpiredError', () => {
    expect(sessionErrorMessage(new SessionExpiredError())).toBeNull();
  });

  it('says the server could not be reached for a network TypeError', () => {
    expect(sessionErrorMessage(new TypeError('Failed to fetch'))).toBe(
      "Couldn't reach GanttSmart. Check your connection and reload.",
    );
  });

  it('says the server could not be reached for a non-OK /api/me (e.g. 5xx)', () => {
    expect(sessionErrorMessage(new Error('internal error'))).toBe(UNREACHABLE_MESSAGE);
  });
});
