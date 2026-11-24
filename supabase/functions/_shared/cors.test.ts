import { describe, expect, it } from 'vitest';
import { getAllowedOrigins, getCorsHeaders, handleCorsPreflight, isAllowedOrigin, jsonResponse } from './cors';

describe('CORS helper', () => {
  const env = {
    allowedAppOrigins: 'https://app.ganttsmart.com, https://staging.ganttsmart.com',
    appOrigin: 'https://gantt.example.com',
    allowedOAuthRedirects: 'https://oauth.example.com/callback, https://app.ganttsmart.com/callback',
    allowLocalhostCors: true,
  };

  it('extracts allowed origins from env vars', () => {
    const origins = getAllowedOrigins(env);
    expect(origins.has('https://app.ganttsmart.com')).toBe(true);
    expect(origins.has('https://staging.ganttsmart.com')).toBe(true);
    expect(origins.has('https://gantt.example.com')).toBe(true);
    expect(origins.has('https://oauth.example.com')).toBe(true);
    expect(origins.has('https://evil.com')).toBe(false);
  });

  it('validates allowed origins correctly', () => {
    expect(isAllowedOrigin('https://app.ganttsmart.com', env)).toBe(true);
    expect(isAllowedOrigin('https://staging.ganttsmart.com', env)).toBe(true);
    expect(isAllowedOrigin('https://gantt.example.com', env)).toBe(true);
    expect(isAllowedOrigin('https://evil.com', env)).toBe(false);
    expect(isAllowedOrigin(null, env)).toBe(false);
    expect(isAllowedOrigin(undefined, env)).toBe(false);
    expect(isAllowedOrigin('', env)).toBe(false);
  });

  it('allows localhost and 127.0.0.1 on any port when allowLocalhostCors is true', () => {
    expect(isAllowedOrigin('http://localhost:5173', env)).toBe(true);
    expect(isAllowedOrigin('http://localhost:3000', env)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:8080', env)).toBe(true);
    expect(isAllowedOrigin('https://localhost:443', env)).toBe(true);

    const noLocalhost = { ...env, allowLocalhostCors: false };
    expect(isAllowedOrigin('http://localhost:5173', noLocalhost)).toBe(false);
  });

  it('returns CORS headers with origin when allowed', () => {
    const req = new Request('https://edge.supabase.co/functions/v1/share-roadmap', {
      headers: { Origin: 'https://app.ganttsmart.com' },
    });
    const headers = getCorsHeaders(req, env);
    expect(headers['Access-Control-Allow-Origin']).toBe('https://app.ganttsmart.com');
    expect(headers['Vary']).toBe('Origin');
    expect(headers['Access-Control-Allow-Headers']).toContain('authorization');
  });

  it('omits Access-Control-Allow-Origin for disallowed origins and sets Vary: Origin', () => {
    const req = new Request('https://edge.supabase.co/functions/v1/share-roadmap', {
      headers: { Origin: 'https://evil.attacker.com' },
    });
    const headers = getCorsHeaders(req, env);
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(headers['Vary']).toBe('Origin');
  });

  it('handles preflight OPTIONS requests', () => {
    // Non-OPTIONS request returns null
    const getReq = new Request('https://edge.supabase.co/functions/v1/share-roadmap', {
      method: 'GET',
      headers: { Origin: 'https://app.ganttsmart.com' },
    });
    expect(handleCorsPreflight(getReq, env)).toBeNull();

    // Allowed origin returns 200 with CORS headers
    const allowedOpt = new Request('https://edge.supabase.co/functions/v1/share-roadmap', {
      method: 'OPTIONS',
      headers: { Origin: 'https://app.ganttsmart.com' },
    });
    const allowedRes = handleCorsPreflight(allowedOpt, env);
    expect(allowedRes).not.toBeNull();
    expect(allowedRes!.status).toBe(200);
    expect(allowedRes!.headers.get('Access-Control-Allow-Origin')).toBe('https://app.ganttsmart.com');

    // Disallowed origin returns 403
    const disallowedOpt = new Request('https://edge.supabase.co/functions/v1/share-roadmap', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.attacker.com' },
    });
    const disallowedRes = handleCorsPreflight(disallowedOpt, env);
    expect(disallowedRes).not.toBeNull();
    expect(disallowedRes!.status).toBe(403);
    expect(disallowedRes!.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(disallowedRes!.headers.get('Vary')).toBe('Origin');
  });

  it('jsonResponse attaches CORS headers and optional custom headers like Cache-Control', async () => {
    const req = new Request('https://edge.supabase.co/functions/v1/linear-token-refresh', {
      headers: { Origin: 'https://app.ganttsmart.com' },
    });
    const res = jsonResponse({ ok: true }, 200, req, { 'Cache-Control': 'no-store' }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.ganttsmart.com');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it('allows share-roadmap get / SharedView from configured app origin', async () => {
    const req = new Request('https://edge.supabase.co/functions/v1/share-roadmap', {
      method: 'POST',
      headers: {
        Origin: 'https://app.ganttsmart.com',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'get', shareToken: 'test-token' }),
    });

    const res = jsonResponse({ projectName: 'Test Project', cachedData: { tasks: [] } }, 200, req, undefined, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.ganttsmart.com');
    expect(res.headers.get('Vary')).toBe('Origin');
    const data = (await res.json()) as { projectName: string };
    expect(data.projectName).toBe('Test Project');
  });

  it('rejects share-roadmap get from disallowed origin without CORS header', () => {
    const req = new Request('https://edge.supabase.co/functions/v1/share-roadmap', {
      method: 'POST',
      headers: {
        Origin: 'https://malicious-site.com',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'get', shareToken: 'test-token' }),
    });

    const res = jsonResponse({ error: 'Unauthorized origin' }, 403, req, undefined, env);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  it('extracts allowed origin from LINEAR_REDIRECT_URI fallback when other vars are unset', () => {
    const fallbackEnv = { linearRedirectUri: 'https://linear-only.example.com/api/callback' };
    const origins = getAllowedOrigins(fallbackEnv);
    expect(origins.has('https://linear-only.example.com')).toBe(true);

    const emptyEnv = {};
    expect(getAllowedOrigins(emptyEnv).size).toBe(0);
    expect(isAllowedOrigin('https://any.com', emptyEnv)).toBe(false);
  });

  it('rejects Origin: null and non-http(s) schemes', () => {
    expect(isAllowedOrigin('null', env)).toBe(false);
    expect(isAllowedOrigin('javascript:alert(1)', env)).toBe(false);
    expect(isAllowedOrigin('data:text/html,payload', env)).toBe(false);
    expect(isAllowedOrigin('file:///etc/passwd', env)).toBe(false);

    const badOriginsEnv = { allowedAppOrigins: 'javascript:alert(1), data:text/html, https://valid.com' };
    const origins = getAllowedOrigins(badOriginsEnv);
    expect(origins.has('https://valid.com')).toBe(true);
    expect(origins.has('null')).toBe(false);
    expect(origins.size).toBe(1);
  });

  it('rejects non-OPTIONS requests with disallowed Origin with 403, and allows requests without Origin', () => {
    const disallowedPost = new Request('https://edge.supabase.co/functions/v1/share-roadmap', {
      method: 'POST',
      headers: { Origin: 'https://evil.com' },
    });
    const disallowedRes = handleCorsPreflight(disallowedPost, env);
    expect(disallowedRes).not.toBeNull();
    expect(disallowedRes!.status).toBe(403);
    expect(disallowedRes!.headers.get('Vary')).toBe('Origin');

    const allowedPost = new Request('https://edge.supabase.co/functions/v1/share-roadmap', {
      method: 'POST',
      headers: { Origin: 'https://app.ganttsmart.com' },
    });
    expect(handleCorsPreflight(allowedPost, env)).toBeNull();

    const noOriginPost = new Request('https://edge.supabase.co/functions/v1/share-roadmap', {
      method: 'POST',
    });
    expect(handleCorsPreflight(noOriginPost, env)).toBeNull();
  });

  it('defaults to Cache-Control: no-store on all JSON responses', () => {
    const res = jsonResponse({ status: 'ok' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
