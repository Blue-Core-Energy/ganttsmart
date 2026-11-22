import { describeError, log } from './log.js';

/** Cloud Run allows 10 seconds after SIGTERM; exit before it kills the instance. */
export const SHUTDOWN_GRACE_MS = 8_000;

export interface ClosableServer {
  close(callback: (err?: Error) => void): void;
}

export function createShutdownHandler(
  server: ClosableServer,
  opts?: { graceMs?: number; exit?: (code: number) => void },
): (signal: string) => void {
  const graceMs = opts?.graceMs ?? SHUTDOWN_GRACE_MS;
  const exit = opts?.exit ?? process.exit;

  return function shutdown(signal: string): void {
    log.info('shutting down', { signal });
    // Stop accepting connections and let in-flight requests finish, but never hang past the grace period.
    setTimeout(() => {
      log.error('Shutdown grace period expired; forcing exit', { signal });
      exit(1);
    }, graceMs).unref();
    server.close((err) => {
      if (err) log.error('Error closing server', { error: describeError(err) });
      exit(err ? 1 : 0);
    });
  };
}
