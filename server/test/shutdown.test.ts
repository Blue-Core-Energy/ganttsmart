import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShutdownHandler } from '../src/shutdown.js';

describe('shutdown handler', () => {
  let logLines: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    logLines = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      logLines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    stdoutSpy.mockRestore();
  });

  function parsedLogs(): Array<Record<string, unknown>> {
    return logLines.map((line) => JSON.parse(line.trimEnd()) as Record<string, unknown>);
  }

  it('exits 0 when server closes cleanly before the grace period expires', () => {
    const exit = vi.fn();
    const server = {
      close: vi.fn((cb: (err?: Error) => void) => {
        cb(undefined);
      }),
    };

    const shutdown = createShutdownHandler(server, { graceMs: 8000, exit });
    shutdown('SIGTERM');

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits 1 when server.close encounters an error', () => {
    const exit = vi.fn();
    const server = {
      close: vi.fn((cb: (err?: Error) => void) => {
        cb(new Error('close failed'));
      }),
    };

    const shutdown = createShutdownHandler(server, { graceMs: 8000, exit });
    shutdown('SIGTERM');

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(parsedLogs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'ERROR',
          message: 'Error closing server',
        }),
      ]),
    );
  });

  it('exits 1 and logs an error when the grace period expires before server closes', () => {
    const exit = vi.fn();
    const server = {
      close: vi.fn((_cb: (err?: Error) => void) => {
        // Never calls callback, simulating hung connections
      }),
    };

    const shutdown = createShutdownHandler(server, { graceMs: 8000, exit });
    shutdown('SIGTERM');

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    // Advance timers past grace period
    vi.advanceTimersByTime(8000);

    expect(exit).toHaveBeenCalledWith(1);
    expect(parsedLogs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'ERROR',
          message: 'Shutdown grace period expired; forcing exit',
          signal: 'SIGTERM',
        }),
      ]),
    );
  });

  it('ignores a second signal so the server is only closed once', () => {
    const exit = vi.fn();
    const server = { close: vi.fn((_cb: (err?: Error) => void) => {}) };

    const shutdown = createShutdownHandler(server, { graceMs: 8000, exit });
    shutdown('SIGTERM');
    shutdown('SIGINT');

    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it('clears the grace timer once the server has closed', () => {
    const exit = vi.fn();
    let closeCb: (err?: Error) => void = () => {};
    const server = {
      close: vi.fn((cb: (err?: Error) => void) => {
        closeCb = cb;
      }),
    };

    const shutdown = createShutdownHandler(server, { graceMs: 8000, exit });
    shutdown('SIGTERM');
    expect(vi.getTimerCount()).toBe(1);

    closeCb(undefined);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(8000);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
