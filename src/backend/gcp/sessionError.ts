import { SessionExpiredError } from './api';

export const UNREACHABLE_MESSAGE = "Couldn't reach GanttSmart. Check your connection and reload.";

/**
 * The message for the sign-in screen after the initial /api/me load failed: null (the default
 * "session expired" text) for an expired session, otherwise "couldn't reach" (network error, 5xx).
 */
export function sessionErrorMessage(error: unknown): string | null {
  return error instanceof SessionExpiredError ? null : UNREACHABLE_MESSAGE;
}
