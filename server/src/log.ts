/** Cloud Logging severity levels used by the server. */
export type LogSeverity = 'INFO' | 'WARNING' | 'ERROR';

const SENSITIVE_PARAM_REGEX =
  /^(?:code|token|access_token|refresh_token|client_secret|secret|api_key|apikey|key|password|state|signature|sig|auth|authorization|code_verifier|id_token)$/i;

const SENSITIVE_KEY_REGEX =
  /^(?:accessToken|access_token|refreshToken|refresh_token|token|secret|password|clientSecret|client_secret|codeVerifier|code_verifier|idToken|id_token|apiKey|api_key|authorization)$/i;

/** Redacts sensitive query parameters, credentials, and hash parameters from a URL string (absolute or relative). */
export function redactUrl(urlStr: string): string {
  try {
    const isRelative = urlStr.startsWith('/') && !urlStr.startsWith('//');
    const dummyBase = 'http://localhost';
    const parsed = new URL(urlStr, isRelative ? dummyBase : undefined);

    if (parsed.username) parsed.username = '[REDACTED]';
    if (parsed.password) parsed.password = '[REDACTED]';

    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_PARAM_REGEX.test(key)) {
        parsed.searchParams.set(key, '[REDACTED]');
      }
    }

    if (parsed.hash && parsed.hash.includes('=')) {
      const hashParams = new URLSearchParams(parsed.hash.slice(1));
      let changed = false;
      for (const key of Array.from(hashParams.keys())) {
        if (SENSITIVE_PARAM_REGEX.test(key)) {
          hashParams.set(key, '[REDACTED]');
          changed = true;
        }
      }
      if (changed) {
        parsed.hash = '#' + hashParams.toString();
      }
    }

    if (isRelative) {
      return parsed.pathname + parsed.search + parsed.hash;
    }
    return parsed.toString();
  } catch {
    return urlStr;
  }
}

/** Redacts bearer tokens, URLs with sensitive query params/hashes, and credentials in arbitrary text. */
export function redactSensitive(text: string): string {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/Bearer\s+[A-Za-z0-9_\-.~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, (match) => redactUrl(match))
    .replace(/(^|[\s"'`([])(\/(?!\/)[A-Za-z0-9_.~/-]*\?[^\s"'`<>)]+)/g, (_all, prefix, url) => prefix + redactUrl(url))
    .replace(/#[A-Za-z0-9_.~/-]*=(?:[^\s"'<>]+)?/gi, (match) => {
      try {
        const params = new URLSearchParams(match.slice(1));
        let changed = false;
        for (const key of Array.from(params.keys())) {
          if (SENSITIVE_PARAM_REGEX.test(key)) {
            params.set(key, '[REDACTED]');
            changed = true;
          }
        }
        return changed ? '#' + params.toString() : match;
      } catch {
        return match;
      }
    });
}

function sanitizeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }
  if (value instanceof Error) {
    return describeError(value);
  }
  if (typeof value === 'string') {
    return redactSensitive(value);
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeValue(item, seen));
    }
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY_REGEX.test(k)) {
        result[k] = '[REDACTED]';
      } else {
        result[k] = sanitizeValue(v, seen);
      }
    }
    return result;
  }
  return value;
}

export interface ErrorDescription {
  name?: string;
  message?: string;
  code?: string | number;
  error?: string;
  cause?: {
    name: string;
    message: string;
    code?: string | number;
  };
}

/**
 * Extracts only safe error metadata (name, message, code, and one level of cause).
 * Never includes stack traces, request objects, headers, tokens, or request bodies.
 */
export function describeError(err: unknown): ErrorDescription {
  if (!(err instanceof Error)) return { error: typeof err };
  const code = (err as { code?: unknown }).code;
  const out: ErrorDescription = {
    name: err.name,
    message: err.message ? redactSensitive(err.message) : err.message,
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
  };
  const cause = err.cause;
  if (cause instanceof Error) {
    const causeCode = (cause as { code?: unknown }).code;
    out.cause = {
      name: cause.name,
      message: cause.message ? redactSensitive(cause.message) : cause.message,
      ...(typeof causeCode === 'string' || typeof causeCode === 'number' ? { code: causeCode } : {}),
    };
  }
  return out;
}

/** Writes one structured JSON line to stdout for Cloud Logging. */
export function writeLog(severity: LogSeverity, message: string, fields?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = { severity, message: redactSensitive(message) };
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (key !== 'severity' && key !== 'message' && value !== undefined) {
        if (SENSITIVE_KEY_REGEX.test(key)) {
          entry[key] = '[REDACTED]';
        } else {
          entry[key] = sanitizeValue(value);
        }
      }
    }
  }
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export const log = {
  info: (message: string, fields?: Record<string, unknown>): void => writeLog('INFO', message, fields),
  warn: (message: string, fields?: Record<string, unknown>): void => writeLog('WARNING', message, fields),
  error: (message: string, fields?: Record<string, unknown>): void => writeLog('ERROR', message, fields),
};
