// Shared CORS and JSON response helpers for Supabase Edge Functions.

export interface CorsEnv {
  allowedAppOrigins?: string;
  appOrigin?: string;
  allowedOAuthRedirects?: string;
  linearRedirectUri?: string;
  allowLocalhostCors?: boolean;
}

export function resolveCorsEnv(explicit?: CorsEnv): CorsEnv {
  if (explicit) return explicit;
  const g = globalThis as {
    Deno?: { env?: { get(k: string): string | undefined } };
    process?: { env?: Record<string, string | undefined> };
  };
  const getEnv = (key: string): string => g.Deno?.env?.get?.(key) ?? g.process?.env?.[key] ?? '';

  return {
    allowedAppOrigins: getEnv('ALLOWED_APP_ORIGINS'),
    appOrigin: getEnv('APP_ORIGIN'),
    allowedOAuthRedirects: getEnv('ALLOWED_OAUTH_REDIRECTS'),
    linearRedirectUri: getEnv('LINEAR_REDIRECT_URI'),
    allowLocalhostCors:
      getEnv('ALLOW_LOCALHOST_CORS') === 'true' || getEnv('ALLOW_LOCALHOST_OAUTH_REDIRECT') === 'true',
  };
}

export function getAllowedOrigins(envOpts?: CorsEnv): Set<string> {
  const env = resolveCorsEnv(envOpts);
  const origins = new Set<string>();

  const add = (val?: string) => {
    if (!val) return;
    for (const part of val.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      try {
        const url = new URL(trimmed);
        if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== 'null') {
          origins.add(url.origin);
        }
      } catch {
        // Not a URL with scheme; ignore invalid entries
      }
    }
  };

  add(env.allowedAppOrigins);
  add(env.appOrigin);
  add(env.allowedOAuthRedirects);
  add(env.linearRedirectUri);

  return origins;
}

export function isAllowedOrigin(origin: string | null | undefined, envOpts?: CorsEnv): boolean {
  if (!origin || typeof origin !== 'string') return false;
  const trimmed = origin.trim();
  if (!trimmed || trimmed === 'null') return false;

  const env = resolveCorsEnv(envOpts);

  let normalized: string;
  try {
    const url = new URL(trimmed);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin === 'null') {
      return false;
    }
    normalized = url.origin;
  } catch {
    return false;
  }

  if (env.allowLocalhostCors) {
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(?::\d+)?$/i.test(normalized)) {
      return true;
    }
  }

  const allowed = getAllowedOrigins(envOpts);
  return allowed.has(normalized);
}

export function getCorsHeaders(req: Request, envOpts?: CorsEnv): Record<string, string> {
  const origin = req.headers.get('Origin') ?? req.headers.get('origin');
  const headers: Record<string, string> = {
    Vary: 'Origin',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE',
  };

  if (origin && isAllowedOrigin(origin, envOpts)) {
    try {
      headers['Access-Control-Allow-Origin'] = new URL(origin.trim()).origin;
    } catch {
      // Ignore URL parse error
    }
  }

  return headers;
}

export function handleCors(req: Request, envOpts?: CorsEnv): Response | null {
  const origin = req.headers.get('Origin') ?? req.headers.get('origin');

  if (req.method === 'OPTIONS') {
    if (origin && !isAllowedOrigin(origin, envOpts)) {
      return new Response('Forbidden origin', { status: 403, headers: { Vary: 'Origin' } });
    }
    return new Response('ok', { status: 200, headers: getCorsHeaders(req, envOpts) });
  }

  // Reject requests with a disallowed Origin header (prevents cross-origin quota-burning simple POSTs)
  if (origin && !isAllowedOrigin(origin, envOpts)) {
    return new Response('Forbidden origin', { status: 403, headers: { Vary: 'Origin' } });
  }

  return null;
}

export function handleCorsPreflight(req: Request, envOpts?: CorsEnv): Response | null {
  return handleCors(req, envOpts);
}

export function jsonResponse(
  body: unknown,
  status = 200,
  req?: Request,
  extraHeaders?: Record<string, string>,
  envOpts?: CorsEnv,
): Response {
  const corsHeaders = req ? getCorsHeaders(req, envOpts) : {};
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}
