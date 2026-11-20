/** Cloud Logging severity levels used by the server. */
export type LogSeverity = 'INFO' | 'WARNING' | 'ERROR';

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
    message: err.message,
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
  };
  const cause = err.cause;
  if (cause instanceof Error) {
    const causeCode = (cause as { code?: unknown }).code;
    out.cause = {
      name: cause.name,
      message: cause.message,
      ...(typeof causeCode === 'string' || typeof causeCode === 'number' ? { code: causeCode } : {}),
    };
  }
  return out;
}

/** Writes one structured JSON line to stdout for Cloud Logging. */
export function writeLog(severity: LogSeverity, message: string, fields?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = { severity, message };
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (key !== 'severity' && key !== 'message' && value !== undefined) {
        entry[key] = value;
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
