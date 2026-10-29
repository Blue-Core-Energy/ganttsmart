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

/**
 * Builds the server config from environment variables. Throws (so the server refuses to start)
 * on anything missing or unsafe. Error messages name variables but never include secret values.
 */
export function loadConfig(env: Env): Config {
  const isProduction = env.NODE_ENV === 'production';
  const devUserEmail = optional(env, 'DEV_USER_EMAIL');
  const iapAudience = optional(env, 'IAP_AUDIENCE');

  if (isProduction && devUserEmail !== null) {
    throw new Error('DEV_USER_EMAIL is not allowed when NODE_ENV=production');
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
    appOrigin: required(env, 'APP_ORIGIN'),
    allowedDomain: (optional(env, 'ALLOWED_EMAIL_DOMAIN') ?? 'bluecore.energy').toLowerCase(),
    iapAudience,
    devUserEmail,
    linearClientId: required(env, 'LINEAR_CLIENT_ID'),
    linearClientSecret: required(env, 'LINEAR_CLIENT_SECRET'),
    linearRedirectUri: required(env, 'LINEAR_REDIRECT_URI'),
    staticDir: optional(env, 'STATIC_DIR') ?? 'dist',
  };
}
