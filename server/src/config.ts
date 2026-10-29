import { isAllowedEmail } from './identity.js';

export interface Config {
  port: number;
  isProduction: boolean;
  appOrigin: string;
  allowedDomain: string;
  iapAudience: string | null;
  devUserEmail: string | null;
  linearClientId: string;
  linearClientSecret: string;
  linearRedirectUri: string;
  staticDir: string;
}

type Env = Record<string, string | undefined>;

/** Returns the trimmed value, treating unset and empty as missing. */
function optional(env: Env, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

function required(env: Env, name: string): string {
  const value = optional(env, name);
  if (value === null) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function parsePort(raw: string | null): number {
  if (raw === null) return 8080;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${raw}`);
  }
  return port;
}

function parseOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid APP_ORIGIN: must be an absolute http(s) URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Invalid APP_ORIGIN: must be an absolute http(s) URL');
  }
  return url.origin;
}

/**
 * Builds the server config from environment variables. Throws (so the server refuses to start)
 * on anything missing or unsafe. Error messages name variables but never include secret values.
 */
export function loadConfig(env: Env): Config {
  const isProduction = env.NODE_ENV?.trim().toLowerCase() === 'production';
  const devUserEmail = optional(env, 'DEV_USER_EMAIL');
  const iapAudience = optional(env, 'IAP_AUDIENCE');
  const onCloudRun = optional(env, 'K_SERVICE') !== null;
  const allowedDomain = (optional(env, 'ALLOWED_EMAIL_DOMAIN') ?? 'bluecore.energy').toLowerCase();

  // The dev bypass replaces IAP verification with one fixed user, so refuse it on anything that
  // looks like a deployment, not only when NODE_ENV is spelled exactly right.
  if (devUserEmail !== null) {
    if (isProduction) throw new Error('DEV_USER_EMAIL is not allowed when NODE_ENV=production');
    if (iapAudience !== null) throw new Error('DEV_USER_EMAIL is not allowed when IAP_AUDIENCE is set');
    if (onCloudRun) throw new Error('DEV_USER_EMAIL is not allowed on Cloud Run (K_SERVICE is set)');
    if (!isAllowedEmail(devUserEmail, allowedDomain)) {
      throw new Error('DEV_USER_EMAIL must be an address in ALLOWED_EMAIL_DOMAIN');
    }
  }
  if (devUserEmail === null && iapAudience === null) {
    throw new Error(
      isProduction
        ? 'IAP_AUDIENCE is required when NODE_ENV=production'
        : 'IAP_AUDIENCE is required unless DEV_USER_EMAIL is set for local development',
    );
  }

  return {
    port: parsePort(optional(env, 'PORT')),
    isProduction,
    appOrigin: parseOrigin(required(env, 'APP_ORIGIN')),
    allowedDomain,
    iapAudience,
    devUserEmail,
    linearClientId: required(env, 'LINEAR_CLIENT_ID'),
    linearClientSecret: required(env, 'LINEAR_CLIENT_SECRET'),
    linearRedirectUri: required(env, 'LINEAR_REDIRECT_URI'),
    staticDir: optional(env, 'STATIC_DIR') ?? 'dist',
  };
}
