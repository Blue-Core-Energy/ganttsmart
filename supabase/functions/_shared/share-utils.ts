/**
 * Runtime-agnostic helpers for share-roadmap operations.
 * Shared between Deno Edge Functions and Vitest tests (Node/browser).
 * No Deno or JSR imports.
 */

export const MAX_EXPIRY_DAYS = 90;
export const MAX_PASSWORD_ATTEMPTS = 5;
export const MAX_AGGREGATE_ATTEMPTS = 25;
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
export const STALE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function validatePassword(password: unknown): { valid: boolean; error?: string } {
  if (typeof password !== 'string') {
    return { valid: false, error: 'Password must be a string' };
  }
  if (password.length > 128) {
    return { valid: false, error: 'Password must be at most 128 characters' };
  }
  return { valid: true };
}

export function validateExpiresInDays(days: unknown): { valid: boolean; error?: string; value?: number } {
  if (days === undefined) {
    return { valid: true, value: 3 };
  }
  if (days === null || typeof days !== 'number' || !Number.isInteger(days) || !Number.isFinite(days)) {
    return { valid: false, error: `expiresInDays must be an integer between 1 and ${MAX_EXPIRY_DAYS}` };
  }
  if (days < 1 || days > MAX_EXPIRY_DAYS) {
    return { valid: false, error: `expiresInDays must be an integer between 1 and ${MAX_EXPIRY_DAYS}` };
  }
  return { valid: true, value: days };
}

export function isRateLimited(
  attemptCount: number,
  firstAttemptAt: Date | string | number,
  maxAttempts: number = MAX_PASSWORD_ATTEMPTS,
  windowMs: number = RATE_LIMIT_WINDOW_MS,
  now: number = Date.now(),
): { blocked: boolean; retryAfterSeconds: number } {
  const firstMs = typeof firstAttemptAt === 'number' ? firstAttemptAt : new Date(firstAttemptAt).getTime();
  const elapsed = now - firstMs;

  if (elapsed >= windowMs) {
    return { blocked: false, retryAfterSeconds: 0 };
  }

  if (attemptCount > maxAttempts) {
    const remainingMs = firstMs + windowMs - now;
    const retryAfterSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
    return { blocked: true, retryAfterSeconds };
  }

  return { blocked: false, retryAfterSeconds: 0 };
}

export function canClaimRefresh(
  cachedAt: Date | string | number | null | undefined,
  refreshingUntil: Date | string | number | null | undefined,
  staleTtlMs: number = STALE_TTL_MS,
  now: number = Date.now(),
): boolean {
  if (cachedAt) {
    const cachedMs = typeof cachedAt === 'number' ? cachedAt : new Date(cachedAt).getTime();
    if (now - cachedMs <= staleTtlMs) {
      return false;
    }
  }

  if (refreshingUntil) {
    const leaseUntilMs = typeof refreshingUntil === 'number' ? refreshingUntil : new Date(refreshingUntil).getTime();
    if (leaseUntilMs > now) {
      return false;
    }
  }

  return true;
}

export function extractClientIp(headers: Headers | { get(name: string): string | null }): string {
  const cfIp = headers.get('cf-connecting-ip')?.trim();
  if (cfIp) return cfIp;

  const realIp = headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;

  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const parts = forwarded
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const rightmost = parts.pop();
    if (rightmost) return rightmost;
  }

  return 'unknown-client';
}

export function toHex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function fromHex(hex: string): Uint8Array {
  const matches = hex.match(/.{2}/g);
  if (!matches) return new Uint8Array(0);
  const arr = new Uint8Array(matches.length);
  for (let i = 0; i < matches.length; i++) {
    arr[i] = parseInt(matches[i], 16);
  }
  return arr;
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function hashPasswordPBKDF2(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return `pbkdf2:${toHex(salt)}:${toHex(new Uint8Array(bits))}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  if (!stored.startsWith('pbkdf2:')) {
    // Legacy static-salt SHA-256 is deprecated and dropped.
    return false;
  }
  const parts = stored.split(':');
  if (parts.length !== 3) return false;
  const [, saltHex, expectedHash] = parts;
  if (!saltHex || !expectedHash) return false;
  const salt = fromHex(saltHex);
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return constantTimeEqual(toHex(new Uint8Array(bits)), expectedHash);
}

export async function computeClientIpHash(rawIp: string): Promise<string> {
  const data = new TextEncoder().encode(`share-rate-limit:${rawIp || 'unknown-client'}`);
  const hashBuf = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(hashBuf));
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/**
 * Match start date from issue descriptions:
 * Supports `start: YYYY-MM-DD` and legacy `start: DD-MM-YY`.
 * Returns YYYY-MM-DD or null.
 */
export function parseStartDate(description: string | null | undefined): string | null {
  if (!description) return null;
  const isoMatch = description.match(/start:\s*(\d{4})-(\d{2})-(\d{2})(?!\d)/i);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10);
    const day = parseInt(isoMatch[3], 10);
    if (!isValidCalendarDate(year, month, day)) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const legacyMatch = description.match(/start:\s*(\d{2})-(\d{2})-(\d{2})(?!\d)/i);
  if (legacyMatch) {
    const [, dd, mm, yy] = legacyMatch;
    const year = 2000 + parseInt(yy, 10);
    const month = parseInt(mm, 10);
    const day = parseInt(dd, 10);
    if (!isValidCalendarDate(year, month, day)) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return null;
}

/**
 * Strips sensitive internal Linear issue details (raw description and internal URL)
 * while preserving parsed scheduling metadata (startDate, due dates) and assignee names.
 */
export function sanitizeTask<T extends Record<string, unknown>>(task: T): T {
  if (!task || typeof task !== 'object') return task;
  const description = typeof task.description === 'string' ? task.description : null;
  const startDate =
    typeof task.startDate === 'string' && task.startDate.length > 0 ? task.startDate : parseStartDate(description);
  return {
    ...task,
    startDate: startDate ?? null,
    description: '',
    url: '',
  };
}

/**
 * Strips sensitive internal details (description and url) from milestones.
 */
export function sanitizeMilestone<T extends Record<string, unknown>>(milestone: T): T {
  if (!milestone || typeof milestone !== 'object') return milestone;
  return {
    ...milestone,
    description: '',
    url: '',
  };
}

/**
 * Sanitizes all tasks and milestones within a cached roadmap data structure, redacting raw issue descriptions
 * and internal Linear URLs from tasks, doneTasks, unscheduledTasks, externalTasks,
 * externalUnscheduledTasks, and milestones.
 */
export function sanitizeCachedRoadmapData<T extends Record<string, unknown>>(data: T): T {
  if (!data || typeof data !== 'object') return data;
  const result: Record<string, unknown> = { ...data };
  if (Array.isArray(data.tasks)) {
    result.tasks = data.tasks.map((t) => (t && typeof t === 'object' ? sanitizeTask(t as Record<string, unknown>) : t));
  }
  if (Array.isArray(data.doneTasks)) {
    result.doneTasks = data.doneTasks.map((t) =>
      t && typeof t === 'object' ? sanitizeTask(t as Record<string, unknown>) : t,
    );
  }
  if (Array.isArray(data.unscheduledTasks)) {
    result.unscheduledTasks = data.unscheduledTasks.map((t) =>
      t && typeof t === 'object' ? sanitizeTask(t as Record<string, unknown>) : t,
    );
  }
  if (Array.isArray(data.externalTasks)) {
    result.externalTasks = data.externalTasks.map((t) =>
      t && typeof t === 'object' ? sanitizeTask(t as Record<string, unknown>) : t,
    );
  }
  if (Array.isArray(data.externalUnscheduledTasks)) {
    result.externalUnscheduledTasks = data.externalUnscheduledTasks.map((t) =>
      t && typeof t === 'object' ? sanitizeTask(t as Record<string, unknown>) : t,
    );
  }
  if (Array.isArray(data.milestones)) {
    result.milestones = data.milestones.map((m) =>
      m && typeof m === 'object' ? sanitizeMilestone(m as Record<string, unknown>) : m,
    );
  }
  return result as T;
}
