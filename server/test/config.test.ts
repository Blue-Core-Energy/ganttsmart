import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  APP_ORIGIN: 'https://ganttsmart.bluecore.energy',
  LINEAR_CLIENT_ID: 'client-id',
  LINEAR_CLIENT_SECRET: 'client-secret',
  LINEAR_REDIRECT_URI: 'https://ganttsmart.bluecore.energy/api/linear/callback',
};

describe('loadConfig', () => {
  it('refuses DEV_USER_EMAIL in production', () => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        IAP_AUDIENCE: '/projects/1/global/backendServices/2',
        DEV_USER_EMAIL: 'a@bluecore.energy',
      }),
    ).toThrow(/DEV_USER_EMAIL/);
  });

  it('treats NODE_ENV as production regardless of case and whitespace', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'Production ', DEV_USER_EMAIL: 'a@bluecore.energy' })).toThrow(
      /DEV_USER_EMAIL/,
    );
    const config = loadConfig({
      ...base,
      NODE_ENV: ' PRODUCTION',
      IAP_AUDIENCE: '/projects/1/global/backendServices/2',
    });
    expect(config.isProduction).toBe(true);
  });

  it('refuses DEV_USER_EMAIL when IAP_AUDIENCE is set, even without NODE_ENV', () => {
    expect(() =>
      loadConfig({
        ...base,
        IAP_AUDIENCE: '/projects/1/global/backendServices/2',
        DEV_USER_EMAIL: 'a@bluecore.energy',
      }),
    ).toThrow(/DEV_USER_EMAIL/);
  });

  it('refuses DEV_USER_EMAIL on Cloud Run (K_SERVICE set), even without NODE_ENV', () => {
    expect(() => loadConfig({ ...base, K_SERVICE: 'ganttsmart', DEV_USER_EMAIL: 'a@bluecore.energy' })).toThrow(
      /DEV_USER_EMAIL/,
    );
  });

  it('allows DEV_USER_EMAIL alone in development', () => {
    const config = loadConfig({ ...base, NODE_ENV: 'development', DEV_USER_EMAIL: 'dev@bluecore.energy' });
    expect(config).toMatchObject({ isProduction: false, devUserEmail: 'dev@bluecore.energy', iapAudience: null });
  });

  it('refuses a DEV_USER_EMAIL outside the allowed domain', () => {
    expect(() => loadConfig({ ...base, DEV_USER_EMAIL: 'dev@gmail.com' })).toThrow(/DEV_USER_EMAIL/);
  });

  it('normalises APP_ORIGIN to a bare origin', () => {
    const config = loadConfig({
      ...base,
      APP_ORIGIN: 'https://Ganttsmart.Bluecore.Energy/',
      DEV_USER_EMAIL: 'dev@bluecore.energy',
    });
    expect(config.appOrigin).toBe('https://ganttsmart.bluecore.energy');
  });

  it.each(['not a url', 'ftp://ganttsmart.bluecore.energy'])('rejects APP_ORIGIN %j', (origin) => {
    expect(() => loadConfig({ ...base, APP_ORIGIN: origin, DEV_USER_EMAIL: 'dev@bluecore.energy' })).toThrow(
      /APP_ORIGIN/,
    );
  });

  it('requires IAP_AUDIENCE in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/IAP_AUDIENCE/);
  });

  it('requires IAP_AUDIENCE outside production when no DEV_USER_EMAIL is set', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'development' })).toThrow(/IAP_AUDIENCE/);
  });

  it('requires LINEAR_CLIENT_SECRET', () => {
    const { LINEAR_CLIENT_SECRET: _omit, ...rest } = base;
    expect(() => loadConfig({ ...rest, DEV_USER_EMAIL: 'dev@bluecore.energy' })).toThrow(/LINEAR_CLIENT_SECRET/);
  });

  it('treats an empty LINEAR_CLIENT_SECRET as missing', () => {
    expect(() => loadConfig({ ...base, LINEAR_CLIENT_SECRET: '', DEV_USER_EMAIL: 'dev@bluecore.energy' })).toThrow(
      /LINEAR_CLIENT_SECRET/,
    );
  });

  it.each(['APP_ORIGIN', 'LINEAR_CLIENT_ID', 'LINEAR_REDIRECT_URI'] as const)('requires %s', (name) => {
    const env: Record<string, string | undefined> = { ...base, DEV_USER_EMAIL: 'dev@bluecore.energy' };
    delete env[name];
    expect(() => loadConfig(env)).toThrow(new RegExp(name));
  });

  it('rejects an invalid PORT', () => {
    expect(() => loadConfig({ ...base, DEV_USER_EMAIL: 'dev@bluecore.energy', PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...base, DEV_USER_EMAIL: 'dev@bluecore.energy', PORT: '70000' })).toThrow(/PORT/);
  });

  it('applies defaults', () => {
    const config = loadConfig({ ...base, DEV_USER_EMAIL: 'dev@bluecore.energy' });
    expect(config).toEqual({
      port: 8080,
      isProduction: false,
      appOrigin: 'https://ganttsmart.bluecore.energy',
      allowedDomain: 'bluecore.energy',
      iapAudience: null,
      devUserEmail: 'dev@bluecore.energy',
      linearClientId: 'client-id',
      linearClientSecret: 'client-secret',
      linearRedirectUri: 'https://ganttsmart.bluecore.energy/api/linear/callback',
      staticDir: 'dist',
    });
  });

  it('reads a full production config', () => {
    const config = loadConfig({
      ...base,
      NODE_ENV: 'production',
      PORT: '9000',
      ALLOWED_EMAIL_DOMAIN: 'example.com',
      IAP_AUDIENCE: '/projects/1/global/backendServices/2',
      STATIC_DIR: '/app/dist',
    });
    expect(config).toMatchObject({
      port: 9000,
      isProduction: true,
      allowedDomain: 'example.com',
      iapAudience: '/projects/1/global/backendServices/2',
      devUserEmail: null,
      staticDir: '/app/dist',
    });
  });
});
