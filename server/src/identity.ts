import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface Identity {
  sub: string;
  email: string;
}

/** Thrown when a request cannot be tied to an allowed, IAP-authenticated user. */
export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UnauthorizedError';
  }
}

export const IAP_ISSUER = 'https://cloud.google.com/iap';
export const IAP_JWKS_URL = 'https://www.gstatic.com/iap/verify/public_key-jwk';
const IAP_ALGORITHM = 'ES256';

/**
 * True only when the domain after the LAST `@` equals `domain` exactly, ignoring case.
 * No suffix, subdomain or substring matching; the local part must be non-empty.
 */
export function isAllowedEmail(email: string, domain: string): boolean {
  const at = email.lastIndexOf('@');
  if (at <= 0 || domain === '') return false;
  return email.slice(at + 1).toLowerCase() === domain.toLowerCase();
}

let defaultKeys: JWTVerifyGetKey | undefined;
function iapKeys(): JWTVerifyGetKey {
  defaultKeys ??= createRemoteJWKSet(new URL(IAP_JWKS_URL));
  return defaultKeys;
}

/**
 * Verifies the `x-goog-iap-jwt-assertion` header value: ES256 signature against Google's IAP
 * keys, issuer, audience, expiry, and an email in the allowed domain. Every failure becomes an
 * UnauthorizedError whose message never includes the token.
 */
export function createIapVerifier(opts: {
  audience: string;
  allowedDomain: string;
  keys?: JWTVerifyGetKey;
}): (assertion: string | undefined) => Promise<Identity> {
  const { audience, allowedDomain } = opts;
  if (!audience) throw new Error('createIapVerifier: audience is required');
  if (!allowedDomain) throw new Error('createIapVerifier: allowedDomain is required');
  const keys = opts.keys ?? iapKeys();

  return async (assertion) => {
    if (!assertion) throw new UnauthorizedError('Missing IAP assertion');

    let payload;
    try {
      ({ payload } = await jwtVerify(assertion, keys, {
        issuer: IAP_ISSUER,
        audience,
        algorithms: [IAP_ALGORITHM],
        requiredClaims: ['exp', 'iat', 'sub'],
      }));
    } catch (err) {
      const code = err instanceof errors.JOSEError ? err.code : 'ERR_UNKNOWN';
      throw new UnauthorizedError(`Invalid IAP assertion (${code})`, { cause: err });
    }

    const { sub, email } = payload;
    if (typeof sub !== 'string' || sub === '') throw new UnauthorizedError('IAP assertion has no subject');
    if (typeof email !== 'string' || email === '') throw new UnauthorizedError('IAP assertion has no email');
    if (!isAllowedEmail(email, allowedDomain)) throw new UnauthorizedError('Email domain is not allowed');

    return { sub, email };
  };
}

/** Local-development identity; config.ts refuses to load DEV_USER_EMAIL in production. */
export function createDevIdentity(email: string): () => Promise<Identity> {
  const identity: Identity = { sub: 'dev:' + email, email };
  return async () => ({ ...identity });
}
