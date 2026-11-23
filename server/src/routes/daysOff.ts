import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../app.js';
import { describeError, log } from '../log.js';
import type { DayOffInput, Store } from '../store/types.js';

const MAX_LABEL_LENGTH = 200;
const MAX_NAME_LENGTH = 200;
/** One entry may span at most a year (inclusive), so a typo cannot blank out decades. */
const MAX_RANGE_DAYS = 366;
/** The calendar is shared and listed in full on every page load. */
const MAX_ENTRIES = 1000;
const MAX_BODY_BYTES = 16 * 1024;

/** Same id shape the store hands out: Firestore auto ids and UUIDs. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Thrown by the validators below; turned into a 400 by the route. */
class InvalidInput extends Error {}

function isoDate(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) throw new InvalidInput(`${name} must be a YYYY-MM-DD date`);
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new InvalidInput(`${name} is not a real date`);
  }
  return value;
}

function dayNumber(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
}

function parseInput(body: unknown): DayOffInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new InvalidInput('body must be an object');
  }
  const b = body as Record<string, unknown>;

  if (typeof b.label !== 'string') throw new InvalidInput('label must be a string');
  const label = b.label.trim();
  if (label === '' || label.length > MAX_LABEL_LENGTH) {
    throw new InvalidInput(`label must be 1 to ${MAX_LABEL_LENGTH} characters`);
  }

  const startDate = isoDate(b.startDate, 'startDate');
  const endDate = b.endDate === undefined || b.endDate === null ? startDate : isoDate(b.endDate, 'endDate');
  if (endDate < startDate) throw new InvalidInput('endDate must not be before startDate');
  if (dayNumber(endDate) - dayNumber(startDate) + 1 > MAX_RANGE_DAYS) {
    throw new InvalidInput(`a single entry can cover at most ${MAX_RANGE_DAYS} days`);
  }

  let assigneeName: string | null = null;
  if (b.assigneeName !== undefined && b.assigneeName !== null) {
    if (typeof b.assigneeName !== 'string' || b.assigneeName.length > MAX_NAME_LENGTH) {
      throw new InvalidInput(`assigneeName must be a string of at most ${MAX_NAME_LENGTH} characters or null`);
    }
    assigneeName = b.assigneeName.trim() || null;
  }

  return { label, startDate, endDate, assigneeName };
}

/**
 * The team's shared days off: company closures and one person's time off. Any signed-in user may
 * read and edit the calendar (the app is behind IAP for the company domain); `identity.sub` is
 * recorded as author.
 *
 * With `legacyKeys` the JSON bodies use the pre-rename keys (`nonWorkDays` / `nonWorkDay`) that the
 * previous frontend bundle expects; see the alias mount in app.ts.
 */
export function daysOffRoutes(deps: { store: Store; legacyKeys?: boolean }): Hono<AppEnv> {
  const { store } = deps;
  const listKey = deps.legacyKeys ? 'nonWorkDays' : 'daysOff';
  const itemKey = deps.legacyKeys ? 'nonWorkDay' : 'dayOff';
  const routes = new Hono<AppEnv>();

  routes.onError((err, c) => {
    if (err instanceof InvalidInput) return c.json({ error: err.message }, 400);
    log.error('Days off request failed', { error: describeError(err) });
    return c.json({ error: 'internal error' }, 500);
  });

  routes.use(
    '*',
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'request body too large' }, 413) }),
  );

  routes.get('/', async (c) => {
    return c.json({ [listKey]: await store.listDaysOff() });
  });

  routes.post('/', async (c) => {
    let body: unknown;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      throw new InvalidInput('expected a JSON body');
    }
    const input = parseInput(body);
    // Soft cap: the count and the insert are not atomic, so concurrent adds can overshoot slightly.
    if ((await store.listDaysOff()).length >= MAX_ENTRIES) {
      return c.json({ error: `the calendar is full (${MAX_ENTRIES} entries); remove some first` }, 409);
    }
    const dayOff = await store.addDayOff(c.get('identity').sub, input);
    return c.json({ [itemKey]: dayOff }, 201);
  });

  routes.delete('/:id', async (c) => {
    const id = c.req.param('id');
    if (!ID_PATTERN.test(id)) throw new InvalidInput('id is invalid');
    if (!(await store.deleteDayOff(id))) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true });
  });

  return routes;
}
