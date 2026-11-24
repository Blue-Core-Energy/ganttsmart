// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js';

const mocks = vi.hoisted(() => {
  const invoke = vi.fn();
  return { invoke };
});

vi.mock('@/lib/supabase', () => ({
  supabase: {
    functions: {
      invoke: mocks.invoke,
    },
  },
}));

import { parseFunctionInvokeError, useSharedData } from './useSharedData';

interface HookResult<T> {
  current: T;
}

const cleanups = new Set<() => Promise<void>>();

async function renderHook<T>(hook: () => T): Promise<{ result: HookResult<T>; unmount: () => Promise<void> }> {
  const result: HookResult<T> = { current: undefined as unknown as T };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  const unmount = async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    cleanups.delete(unmount);
  };
  cleanups.add(unmount);

  function Component() {
    result.current = hook();
    return null;
  }

  await act(async () => {
    root.render(createElement(Component));
  });

  return { result, unmount };
}

describe('useSharedData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    for (const cleanup of Array.from(cleanups)) {
      await cleanup();
    }
  });

  describe('parseFunctionInvokeError', () => {
    it('returns null when fnError is null or undefined', async () => {
      expect(await parseFunctionInvokeError(null)).toBeNull();
      expect(await parseFunctionInvokeError(undefined)).toBeNull();
    });

    it('extracts status and JSON payload from FunctionsHttpError context Response', async () => {
      const res = new Response(
        JSON.stringify({ error: 'Incorrect password', requiresPassword: true, needsPassword: true }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      );
      const fnError = new FunctionsHttpError(res);

      const parsed = await parseFunctionInvokeError(fnError);
      expect(parsed).toEqual({
        status: 403,
        message: 'Edge Function returned a non-2xx status code',
        payload: {
          error: 'Incorrect password',
          requiresPassword: true,
          needsPassword: true,
        },
      });
    });

    it('extracts 429 rate limit error payload with retryAfterSeconds', async () => {
      const res = new Response(
        JSON.stringify({ error: 'Too many attempts. Try again later.', retryAfterSeconds: 870 }),
        { status: 429, headers: { 'Content-Type': 'application/json' } },
      );
      const fnError = new FunctionsHttpError(res);

      const parsed = await parseFunctionInvokeError(fnError);
      expect(parsed?.status).toBe(429);
      expect(parsed?.payload?.error).toBe('Too many attempts. Try again later.');
      expect(parsed?.payload?.retryAfterSeconds).toBe(870);
    });

    it('handles direct object contexts without a json() or text() method', async () => {
      const fnError = {
        name: 'FunctionsHttpError',
        message: 'Edge Function returned a non-2xx status code',
        context: {
          status: 403,
          error: 'Incorrect password',
          requiresPassword: true,
        },
      };

      const parsed = await parseFunctionInvokeError(fnError);
      expect(parsed?.status).toBe(403);
      expect(parsed?.payload?.error).toBe('Incorrect password');
      expect(parsed?.payload?.requiresPassword).toBe(true);
    });

    it('handles non-JSON text response contexts gracefully', async () => {
      const res = new Response('Plain text error', { status: 500, headers: { 'Content-Type': 'text/plain' } });
      const fnError = new FunctionsHttpError(res);

      const parsed = await parseFunctionInvokeError(fnError);
      expect(parsed?.status).toBe(500);
      expect(parsed?.payload?.error).toBe('Plain text error');
    });

    it('handles already-consumed Response gracefully without crashing', async () => {
      const res = new Response(JSON.stringify({ error: 'Consumed body' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
      await res.text(); // Consume the stream ahead of time
      const fnError = new FunctionsHttpError(res);

      const parsed = await parseFunctionInvokeError(fnError);
      expect(parsed?.status).toBe(403);
    });

    it('does not treat FunctionsFetchError TypeError context as a JSON payload', async () => {
      const typeError = new TypeError('Failed to fetch');
      const fnError = new FunctionsFetchError(typeError);

      const parsed = await parseFunctionInvokeError(fnError);
      expect(parsed?.payload).toBeNull();
      expect(parsed?.message).toBe('Failed to send a request to the Edge Function');
    });

    it('extracts payload from FunctionsRelayError context Response', async () => {
      const res = new Response(JSON.stringify({ error: 'Relay failure' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
      const fnError = new FunctionsRelayError(res);

      const parsed = await parseFunctionInvokeError(fnError);
      expect(parsed?.status).toBe(500);
      expect(parsed?.payload?.error).toBe('Relay failure');
    });
  });

  describe('useSharedData hook with non-2xx status codes', () => {
    it('surfaces 403 wrong password as passwordError and keeps needsPassword true', async () => {
      const res = new Response(
        JSON.stringify({ error: 'Incorrect password', requiresPassword: true, needsPassword: true }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      );
      const fnError = new FunctionsHttpError(res);
      mocks.invoke.mockResolvedValue({ data: null, error: fnError, response: res });

      const { result } = await renderHook(() => useSharedData('test-token'));

      expect(result.current.loading).toBe(false);
      expect(result.current.needsPassword).toBe(true);
      expect(result.current.passwordError).toBe('Incorrect password');
      expect(result.current.error).toBe(''); // Never crashes to "Link Unavailable"
    });

    it('surfaces 429 rate limit as passwordError and keeps needsPassword true', async () => {
      const res = new Response(
        JSON.stringify({ error: 'Too many attempts. Try again later.', retryAfterSeconds: 850 }),
        { status: 429, headers: { 'Content-Type': 'application/json' } },
      );
      const fnError = new FunctionsHttpError(res);
      mocks.invoke.mockResolvedValue({ data: null, error: fnError, response: res });

      const { result } = await renderHook(() => useSharedData('test-token'));

      expect(result.current.loading).toBe(false);
      expect(result.current.needsPassword).toBe(true);
      expect(result.current.passwordError).toBe('Too many attempts. Try again later.');
      expect(result.current.error).toBe(''); // Never crashes to "Link Unavailable"
    });

    it('surfaces 400 password validation errors in passwordError when submitting a password', async () => {
      mocks.invoke.mockResolvedValueOnce({
        data: { requiresPassword: true, needsPassword: true },
        error: null,
      });

      const { result } = await renderHook(() => useSharedData('protected-token'));
      expect(result.current.needsPassword).toBe(true);

      const res = new Response(JSON.stringify({ error: 'Password must be at most 128 characters' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
      const fnError = new FunctionsHttpError(res);
      mocks.invoke.mockResolvedValueOnce({ data: null, error: fnError, response: res });

      await act(async () => {
        result.current.submitPassword('a'.repeat(129));
      });

      expect(result.current.loading).toBe(false);
      expect(result.current.needsPassword).toBe(true);
      expect(result.current.passwordError).toBe('Password must be at most 128 characters');
      expect(result.current.error).toBe('');
    });

    it('shows Link Unavailable error on 410 expired share', async () => {
      const res = new Response(JSON.stringify({ error: 'This shared link has expired', expired: true }), {
        status: 410,
        headers: { 'Content-Type': 'application/json' },
      });
      const fnError = new FunctionsHttpError(res);
      mocks.invoke.mockResolvedValue({ data: null, error: fnError, response: res });

      const { result } = await renderHook(() => useSharedData('expired-token'));

      expect(result.current.loading).toBe(false);
      expect(result.current.needsPassword).toBe(false);
      expect(result.current.error).toBe('This shared link has expired.');
    });

    it('shows Link Unavailable error on 404 share not found', async () => {
      const res = new Response(JSON.stringify({ error: 'Share not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
      const fnError = new FunctionsHttpError(res);
      mocks.invoke.mockResolvedValue({ data: null, error: fnError, response: res });

      const { result } = await renderHook(() => useSharedData('nonexistent-token'));

      expect(result.current.loading).toBe(false);
      expect(result.current.needsPassword).toBe(false);
      expect(result.current.error).toBe('Share not found');
    });

    it('routes 500 server errors to Link Unavailable screen and sets needsPassword to false', async () => {
      const res = new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
      const fnError = new FunctionsHttpError(res);
      mocks.invoke.mockResolvedValue({ data: null, error: fnError, response: res });

      const { result } = await renderHook(() => useSharedData('test-token'));

      expect(result.current.loading).toBe(false);
      expect(result.current.needsPassword).toBe(false);
      expect(result.current.error).toBe('Internal Server Error');
    });

    it('routes thrown exceptions in catch(e) to Link Unavailable screen with needsPassword false', async () => {
      mocks.invoke.mockRejectedValue(new Error('Network connection offline'));

      const { result } = await renderHook(() => useSharedData('test-token'));

      expect(result.current.loading).toBe(false);
      expect(result.current.needsPassword).toBe(false);
      expect(result.current.error).toBe('Network connection offline');
    });

    it('handles initial pre-auth prompt (200 requiresPassword) and transitions cleanly on password submit', async () => {
      // 1. Initial load requires password
      mocks.invoke.mockResolvedValueOnce({
        data: { requiresPassword: true, needsPassword: true, projectName: 'Protected Project' },
        error: null,
      });

      const { result } = await renderHook(() => useSharedData('protected-token'));

      expect(result.current.loading).toBe(false);
      expect(result.current.needsPassword).toBe(true);
      expect(result.current.passwordError).toBe('');
      expect(result.current.error).toBe('');

      // 2. Submit wrong password -> 403
      const errRes = new Response(
        JSON.stringify({ error: 'Incorrect password', requiresPassword: true, needsPassword: true }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      );
      const fnError = new FunctionsHttpError(errRes);
      mocks.invoke.mockResolvedValueOnce({ data: null, error: fnError, response: errRes });

      await act(async () => {
        result.current.submitPassword('wrong-pw');
      });

      expect(result.current.loading).toBe(false);
      expect(result.current.needsPassword).toBe(true);
      expect(result.current.passwordError).toBe('Incorrect password');
      expect(result.current.error).toBe('');

      // 3. Submit correct password -> 200 with sanitized data
      mocks.invoke.mockResolvedValueOnce({
        data: {
          projectName: 'Protected Project',
          cachedAt: '2026-05-01T12:00:00Z',
          cachedData: {
            tasks: [
              {
                id: 'ENG-1',
                uuid: 'u-1',
                title: 'Secret Feature',
                description: '', // redacted
                url: '', // redacted
                assignee: 'Alice',
                due: '2026-05-10',
                startDate: '2026-05-01',
                priorityVal: 1,
                priority: 'Urgent',
                status: 'Todo',
                statusType: 'unstarted',
                blocks: [],
                blockedBy: [],
              },
            ],
            doneTasks: [],
            unscheduledTasks: [],
            milestones: [],
          },
        },
        error: null,
      });

      await act(async () => {
        result.current.submitPassword('correct-pw');
      });

      expect(result.current.loading).toBe(false);
      expect(result.current.needsPassword).toBe(false);
      expect(result.current.passwordError).toBe('');
      expect(result.current.error).toBe('');
      expect(result.current.projectName).toBe('Protected Project');
      expect(result.current.tasks).toHaveLength(1);
      expect(result.current.tasks[0].id).toBe('ENG-1');
      expect(result.current.tasks[0].description).toBe('');
      expect(result.current.tasks[0].url).toBe('');
      expect(result.current.tasks[0].assignee).toBe('Alice');
    });
  });
});
