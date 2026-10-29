/** The IAP session is gone (or never existed): only a full page reload can sign the user in again. */
export class SessionExpiredError extends Error {
  constructor() {
    super('Your session expired. Reload to sign in again.');
    this.name = 'SessionExpiredError';
  }
}

const listeners = new Set<() => void>();

/** Called whenever apiFetch detects an expired session; returns an unsubscribe function. */
export function onSessionExpired(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function expired(): SessionExpiredError {
  for (const listener of listeners) listener();
  return new SessionExpiredError();
}

/** True if a 401 body is the Linear relay's `{ reconnect: true }` (Linear needs reconnecting, not IAP). */
async function isLinearReconnect(res: Response): Promise<boolean> {
  try {
    const body: unknown = await res.clone().json();
    return typeof body === 'object' && body !== null && (body as { reconnect?: unknown }).reconnect === true;
  } catch {
    return false;
  }
}

/**
 * fetch for the same-origin GanttSmart server behind IAP.
 *
 * IAP answers an expired session with a redirect to Google sign-in; with `redirect: 'manual'` that
 * shows up as an opaque redirect instead of a cross-origin request that fails CORS. That, or a
 * 401 from the server's identity check, throws SessionExpiredError. A 401 with `reconnect: true`
 * is the Linear relay asking the user to reconnect Linear and is returned unchanged (its body
 * still readable), like every other response.
 *
 * fetch rejections (a network TypeError, an AbortError) are rethrown unchanged: they are transient,
 * not an expired session, and gql retries errors whose message mentions "fetch".
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, { ...init, credentials: 'same-origin', redirect: 'manual' });
  if (res.type === 'opaqueredirect') throw expired();
  if (res.status === 401 && !(await isLinearReconnect(res))) throw expired();
  return res;
}

/** The server's `{ error }` message for a failed response, or the HTTP status. */
async function failure(res: Response): Promise<Error> {
  try {
    const body: unknown = await res.json();
    const error = (body as { error?: unknown } | null)?.error;
    if (typeof error === 'string') return new Error(error);
  } catch {
    // Not JSON: fall back to the status below
  }
  return new Error(`Request failed (HTTP ${res.status})`);
}

/** GET and parse JSON; throws on any non-2xx response. */
export async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) throw await failure(res);
  return (await res.json()) as T;
}

/** POST a JSON body; throws on any non-2xx response. */
export async function postJson(path: string, body?: unknown): Promise<void> {
  const res = await apiFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res);
}
