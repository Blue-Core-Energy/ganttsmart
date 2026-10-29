import { beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type CryptoKey, type JWTVerifyGetKey } from 'jose';
import { UnauthorizedError, createDevIdentity, createIapVerifier, isAllowedEmail } from '../src/identity.js';

const AUDIENCE = '/projects/123/global/backendServices/456';
const ISSUER = 'https://cloud.google.com/iap';
const DOMAIN = 'bluecore.energy';

let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let keys: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  const other = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  otherPrivateKey = other.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  keys = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test-key', alg: 'ES256' }] });
});

interface TokenOptions {
  sub?: string;
  email?: string | null;
  aud?: string;
  iss?: string;
  exp?: number | string;
  key?: CryptoKey;
}

async function sign(opts: TokenOptions = {}): Promise<string> {
  const claims: Record<string, unknown> = {};
  if (opts.email !== null) claims.email = opts.email ?? 'someone@bluecore.energy';
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setSubject(opts.sub ?? 'accounts.google.com:1234567890')
    .setAudience(opts.aud ?? AUDIENCE)
    .setIssuer(opts.iss ?? ISSUER)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '10m')
    .sign(opts.key ?? privateKey);
}

function verifier() {
  return createIapVerifier({ audience: AUDIENCE, allowedDomain: DOMAIN, keys });
}

describe('createIapVerifier', () => {
  it('returns the identity for a valid token', async () => {
    await expect(verifier()(await sign())).resolves.toEqual({
      sub: 'accounts.google.com:1234567890',
      email: 'someone@bluecore.energy',
    });
  });

  it('rejects a bad signature', async () => {
    await expect(verifier()(await sign({ key: otherPrivateKey }))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a tampered payload', async () => {
    const token = await sign();
    const [h, , s] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ sub: 'x', email: 'evil@bluecore.energy', aud: AUDIENCE, iss: ISSUER, exp: 9999999999 }),
    ).toString('base64url');
    await expect(verifier()(`${h}.${forged}.${s}`)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects the wrong audience', async () => {
    await expect(verifier()(await sign({ aud: '/projects/999/global/backendServices/1' }))).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it('rejects the wrong issuer', async () => {
    await expect(verifier()(await sign({ iss: 'https://evil.example.com' }))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    await expect(verifier()(await sign({ exp: past }))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a token without exp', async () => {
    const token = await new SignJWT({ email: 'someone@bluecore.energy' })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setSubject('accounts.google.com:1')
      .setAudience(AUDIENCE)
      .setIssuer(ISSUER)
      .setIssuedAt()
      .sign(privateKey);
    await expect(verifier()(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a token without iat', async () => {
    const token = await new SignJWT({ email: 'someone@bluecore.energy' })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
      .setSubject('accounts.google.com:1')
      .setAudience(AUDIENCE)
      .setIssuer(ISSUER)
      .setExpirationTime('10m')
      .sign(privateKey);
    await expect(verifier()(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a token signed with an unexpected algorithm', async () => {
    const token = await new SignJWT({ email: 'someone@bluecore.energy' })
      .setProtectedHeader({ alg: 'HS256', kid: 'test-key' })
      .setSubject('accounts.google.com:1')
      .setAudience(AUDIENCE)
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode('a-shared-secret-that-is-long-enough-123'));
    // jose checks `algorithms` before resolving a key, so this code proves the ES256 pin (without
    // the pin the token would still fail, but with a different code, e.g. ERR_JOSE_NOT_SUPPORTED).
    const err = await verifier()(token).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect((err as Error).message).toMatch(/ERR_JOSE_ALG_NOT_ALLOWED/);
  });

  it('rejects a missing header', async () => {
    await expect(verifier()(undefined)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(verifier()('')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects garbage', async () => {
    await expect(verifier()('not-a-jwt')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects an email outside the allowed domain', async () => {
    await expect(verifier()(await sign({ email: 'someone@gmail.com' }))).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(verifier()(await sign({ email: 'x@evil-bluecore.energy' }))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a token with no email claim', async () => {
    await expect(verifier()(await sign({ email: null }))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('does not put the token in the error message', async () => {
    const token = await sign({ email: 'someone@gmail.com' });
    const err = await verifier()(token).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect((err as Error).message).not.toContain(token);
  });
});

describe('isAllowedEmail', () => {
  it.each([
    ['Someone@BlueCore.Energy', true],
    ['someone@bluecore.energy', true],
    ['x@evil-bluecore.energy', false],
    ['x@bluecore.energy.evil.com', false],
    ['bluecore.energy@gmail.com', false],
    ['x@sub.bluecore.energy', false],
    ['x@bluecore.energy@gmail.com', false],
    ['@bluecore.energy', false],
    ['bluecore.energy', false],
    ['', false],
    ['x@bluecore.energy ', false],
  ])('%j → %s', (email, expected) => {
    expect(isAllowedEmail(email, DOMAIN)).toBe(expected);
  });

  it('ignores case in the configured domain too', () => {
    expect(isAllowedEmail('a@bluecore.energy', 'BlueCore.Energy')).toBe(true);
  });

  it('never allows anything for an empty domain', () => {
    expect(isAllowedEmail('a@', '')).toBe(false);
  });
});

describe('createDevIdentity', () => {
  it('returns a fixed dev identity', async () => {
    await expect(createDevIdentity('dev@bluecore.energy')()).resolves.toEqual({
      sub: 'dev:dev@bluecore.energy',
      email: 'dev@bluecore.energy',
    });
  });
});
