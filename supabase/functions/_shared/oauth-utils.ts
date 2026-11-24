export function base64UrlEncode(buffer: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < buffer.byteLength; i++) {
    binary += String.fromCharCode(buffer[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

export interface RedirectAllowlistEnv {
  linearRedirectUri?: string;
  allowedOAuthRedirects?: string;
  allowLocalhost?: boolean;
}

export function resolveRedirectEnv(explicit?: RedirectAllowlistEnv): RedirectAllowlistEnv {
  if (explicit) return explicit;
  const g = globalThis as {
    Deno?: { env?: { get(k: string): string | undefined } };
    process?: { env?: Record<string, string | undefined> };
  };
  const getEnv = (key: string): string => g.Deno?.env?.get?.(key) ?? g.process?.env?.[key] ?? '';

  return {
    linearRedirectUri: getEnv('LINEAR_REDIRECT_URI'),
    allowedOAuthRedirects: getEnv('ALLOWED_OAUTH_REDIRECTS'),
    allowLocalhost: getEnv('ALLOW_LOCALHOST_OAUTH_REDIRECT') === 'true',
  };
}

export function isAllowedRedirectUri(uri: string, envOpts?: RedirectAllowlistEnv): boolean {
  if (!uri || typeof uri !== 'string') return false;
  try {
    const parsed = new URL(uri);
    const env = resolveRedirectEnv(envOpts);

    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      return (
        Boolean(env.allowLocalhost) &&
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        parsed.pathname === '/callback' &&
        !parsed.search &&
        !parsed.hash &&
        !parsed.username &&
        !parsed.password
      );
    }

    const allowedList = [env.linearRedirectUri, ...(env.allowedOAuthRedirects?.split(',') ?? [])]
      .map((s) => s?.trim())
      .filter((s): s is string => Boolean(s));

    return allowedList.includes(uri);
  } catch {
    return false;
  }
}
