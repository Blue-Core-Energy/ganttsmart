/**
 * The message for the server's `?linear_error=<code>` redirect after a failed Linear connection,
 * or null if the query string has none.
 */
export function readLinearError(search: string): string | null {
  const code = new URLSearchParams(search).get('linear_error');
  if (code === null) return null;
  if (code === 'access_denied') return 'Linear connection was cancelled.';
  return 'Could not connect to Linear. Please try again.';
}
