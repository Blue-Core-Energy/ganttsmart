import { beforeEach, describe, expect, it } from 'vitest';
import type { LinearTokens, Store } from '../src/store/types.js';

const tokensA: LinearTokens = { accessToken: 'access-a', refreshToken: 'refresh-a', expiresAt: 1_000 };
const tokensB: LinearTokens = { accessToken: 'access-b', refreshToken: 'refresh-b', expiresAt: 2_000 };
const tokensC: LinearTokens = { accessToken: 'access-c', refreshToken: 'refresh-c', expiresAt: 3_000 };

let counter = 0;

/**
 * Shared behavioural contract every Store implementation must satisfy. Pass `enabled = false` to
 * register the suite as skipped (e.g. Firestore without an emulator).
 */
export function runStoreContract(name: string, makeStore: () => Store, enabled = true): void {
  (enabled ? describe : describe.skip)(`Store contract: ${name}`, () => {
    let store: Store;
    let alice: string;
    let bob: string;

    beforeEach(() => {
      store = makeStore();
      // Unique subs per test so a shared backend (the Firestore emulator) never leaks state between tests.
      counter += 1;
      const run = `${Date.now()}-${Math.random().toString(36).slice(2)}-${counter}`;
      alice = `alice-${run}`;
      bob = `bob-${run}`;
    });

    describe('tokens', () => {
      it('returns null when nothing is stored', async () => {
        expect(await store.getTokens(alice)).toBeNull();
      });

      it('round-trips save, get and clear', async () => {
        await store.saveTokens(alice, 'alice@bluecore.energy', tokensA);
        expect(await store.getTokens(alice)).toEqual(tokensA);

        await store.saveTokens(alice, 'alice@bluecore.energy', tokensB);
        expect(await store.getTokens(alice)).toEqual(tokensB);

        await store.clearTokens(alice);
        expect(await store.getTokens(alice)).toBeNull();
      });

      it('stores a null refresh token and expiry', async () => {
        const bare: LinearTokens = { accessToken: 'only-access', refreshToken: null, expiresAt: null };
        await store.saveTokens(alice, 'alice@bluecore.energy', bare);
        expect(await store.getTokens(alice)).toEqual(bare);
      });

      it('swapTokens with the matching refresh token writes and returns next', async () => {
        await store.saveTokens(alice, 'alice@bluecore.energy', tokensA);
        expect(await store.swapTokens(alice, 'refresh-a', tokensB)).toEqual(tokensB);
        expect(await store.getTokens(alice)).toEqual(tokensB);
      });

      it('swapTokens with a stale refresh token returns the stored tokens and does not overwrite', async () => {
        await store.saveTokens(alice, 'alice@bluecore.energy', tokensA);
        await store.swapTokens(alice, 'refresh-a', tokensB); // the winner
        expect(await store.swapTokens(alice, 'refresh-a', tokensC)).toEqual(tokensB); // the loser
        expect(await store.getTokens(alice)).toEqual(tokensB);
      });

      it('swapTokens with nothing stored returns null without writing', async () => {
        expect(await store.swapTokens(alice, 'refresh-a', tokensB)).toBeNull();
        expect(await store.getTokens(alice)).toBeNull();
      });

      it('swapTokens after clearTokens returns null without writing', async () => {
        await store.saveTokens(alice, 'alice@bluecore.energy', tokensA);
        await store.clearTokens(alice);
        expect(await store.swapTokens(alice, 'refresh-a', tokensB)).toBeNull();
        expect(await store.getTokens(alice)).toBeNull();
      });

      it('clearTokens with matching expectedRefreshToken clears and returns true', async () => {
        await store.saveTokens(alice, 'alice@bluecore.energy', tokensA);
        expect(await store.clearTokens(alice, 'refresh-a')).toBe(true);
        expect(await store.getTokens(alice)).toBeNull();
      });

      it('clearTokens with non-matching expectedRefreshToken does not clear and returns false', async () => {
        await store.saveTokens(alice, 'alice@bluecore.energy', tokensA);
        expect(await store.clearTokens(alice, 'stale-refresh')).toBe(false);
        expect(await store.getTokens(alice)).toEqual(tokensA);
      });

      it('clearTokens with expectedRefreshToken on empty store returns false', async () => {
        expect(await store.clearTokens(alice, 'refresh-a')).toBe(false);
      });

      it('clearTokens with no expectedRefreshToken clears unconditionally and returns true', async () => {
        await store.saveTokens(alice, 'alice@bluecore.energy', tokensA);
        expect(await store.clearTokens(alice)).toBe(true);
        expect(await store.getTokens(alice)).toBeNull();
      });

      it('isolates tokens between users', async () => {
        await store.saveTokens(alice, 'alice@bluecore.energy', tokensA);
        await store.saveTokens(bob, 'bob@bluecore.energy', tokensB);
        expect(await store.getTokens(alice)).toEqual(tokensA);
        expect(await store.getTokens(bob)).toEqual(tokensB);

        // Alice's refresh token means nothing for Bob.
        expect(await store.swapTokens(bob, 'refresh-a', tokensC)).toEqual(tokensB);
        await store.clearTokens(alice);
        expect(await store.getTokens(alice)).toBeNull();
        expect(await store.getTokens(bob)).toEqual(tokensB);
      });
    });

    describe('baselines', () => {
      it('returns an empty list when nothing is stored', async () => {
        expect(await store.listBaselines(alice, 'proj-1')).toEqual([]);
      });

      it('keeps the first-seen values when added twice', async () => {
        await store.addBaselinesIfAbsent(alice, 'proj-1', [
          { issue_id: 'ISS-1', planned_start: '2026-11-01', planned_due: '2026-11-10' },
        ]);
        const [first] = await store.listBaselines(alice, 'proj-1');
        expect(first).toMatchObject({ issue_id: 'ISS-1', planned_start: '2026-11-01', planned_due: '2026-11-10' });
        expect(new Date(first.first_seen_at).toISOString()).toBe(first.first_seen_at);

        await store.addBaselinesIfAbsent(alice, 'proj-1', [
          { issue_id: 'ISS-1', planned_start: '2026-12-01', planned_due: '2026-12-20' },
          { issue_id: 'ISS-2', planned_start: null, planned_due: '2026-11-15' },
        ]);
        const rows = await store.listBaselines(alice, 'proj-1');
        expect(rows).toHaveLength(2);
        const byId = new Map(rows.map((r) => [r.issue_id, r]));
        expect(byId.get('ISS-1')).toEqual(first);
        expect(byId.get('ISS-2')).toMatchObject({ planned_start: null, planned_due: '2026-11-15' });
      });

      it('filters by project', async () => {
        await store.addBaselinesIfAbsent(alice, 'proj-1', [
          { issue_id: 'ISS-1', planned_start: null, planned_due: '2026-11-10' },
        ]);
        await store.addBaselinesIfAbsent(alice, 'proj-2', [
          { issue_id: 'ISS-2', planned_start: null, planned_due: '2026-11-20' },
        ]);
        expect((await store.listBaselines(alice, 'proj-1')).map((r) => r.issue_id)).toEqual(['ISS-1']);
        expect((await store.listBaselines(alice, 'proj-2')).map((r) => r.issue_id)).toEqual(['ISS-2']);
        expect(await store.listBaselines(alice, 'proj-3')).toEqual([]);
      });

      it('accepts an empty batch', async () => {
        await store.addBaselinesIfAbsent(alice, 'proj-1', []);
        expect(await store.listBaselines(alice, 'proj-1')).toEqual([]);
      });

      it('isolates baselines between users', async () => {
        await store.addBaselinesIfAbsent(alice, 'proj-1', [
          { issue_id: 'ISS-1', planned_start: null, planned_due: '2026-11-10' },
        ]);
        await store.addBaselinesIfAbsent(bob, 'proj-1', [
          { issue_id: 'ISS-1', planned_start: null, planned_due: '2026-12-31' },
        ]);
        expect((await store.listBaselines(alice, 'proj-1')).map((r) => r.planned_due)).toEqual(['2026-11-10']);
        expect((await store.listBaselines(bob, 'proj-1')).map((r) => r.planned_due)).toEqual(['2026-12-31']);
      });
    });

    describe('changes', () => {
      it('returns an empty list when nothing is stored', async () => {
        expect(await store.listChanges(alice, 'ISS-1', 10)).toEqual([]);
      });

      it('lists newest first, respects the limit and filters by issue', async () => {
        for (let i = 1; i <= 4; i++) {
          await store.addChange(alice, {
            projectId: 'proj-1',
            issueId: 'ISS-1',
            field: 'due_date',
            oldValue: i === 1 ? null : `v${i - 1}`,
            newValue: `v${i}`,
          });
        }
        await store.addChange(alice, {
          projectId: 'proj-1',
          issueId: 'ISS-2',
          field: 'due_date',
          oldValue: null,
          newValue: 'other',
        });

        const all = await store.listChanges(alice, 'ISS-1', 10);
        expect(all.map((c) => c.new_value)).toEqual(['v4', 'v3', 'v2', 'v1']);
        expect(all[3]).toEqual({
          issue_id: 'ISS-1',
          field_changed: 'due_date',
          old_value: null,
          new_value: 'v1',
          changed_at: all[3].changed_at,
        });
        for (const c of all) expect(new Date(c.changed_at).toISOString()).toBe(c.changed_at);

        expect((await store.listChanges(alice, 'ISS-1', 2)).map((c) => c.new_value)).toEqual(['v4', 'v3']);
        expect((await store.listChanges(alice, 'ISS-2', 10)).map((c) => c.new_value)).toEqual(['other']);
      });

      it('isolates changes between users', async () => {
        await store.addChange(alice, { projectId: 'p', issueId: 'ISS-1', field: 'f', oldValue: null, newValue: 'a' });
        await store.addChange(bob, { projectId: 'p', issueId: 'ISS-1', field: 'f', oldValue: null, newValue: 'b' });
        expect((await store.listChanges(alice, 'ISS-1', 10)).map((c) => c.new_value)).toEqual(['a']);
        expect((await store.listChanges(bob, 'ISS-1', 10)).map((c) => c.new_value)).toEqual(['b']);
      });
    });

    describe('transitions', () => {
      // Status transitions are write-only audit log events (no listTransitions read path on Store or HTTP routes).
      it('accepts a transition', async () => {
        await expect(
          store.addTransition(alice, { projectId: 'proj-1', issueId: 'ISS-1', fromStatus: null, toStatus: 'Todo' }),
        ).resolves.toBeUndefined();
      });
    });

    describe('days off', () => {
      // The calendar is shared by every user, so a shared backend (the Firestore emulator) can hold
      // entries from other tests: these look entries up by the unique label of this run.
      let tag: string;
      beforeEach(() => {
        tag = alice.replace('alice-', 'nwd-');
      });
      const mine = async () => (await store.listDaysOff()).filter((e) => e.label.startsWith(tag));

      it('adds a company-wide entry and lists it with its generated id', async () => {
        const added = await store.addDayOff(alice, {
          label: `${tag} Thanksgiving`,
          startDate: '2026-11-26',
          endDate: '2026-11-26',
          assigneeName: null,
        });
        expect(added.id).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
        expect(added).toEqual({
          id: added.id,
          label: `${tag} Thanksgiving`,
          startDate: '2026-11-26',
          endDate: '2026-11-26',
          assigneeName: null,
        });
        expect(await mine()).toEqual([added]);
      });

      it('stores a per-assignee range and gives every entry its own id', async () => {
        const a = await store.addDayOff(alice, {
          label: `${tag} Alex Out`,
          startDate: '2026-12-21',
          endDate: '2026-12-31',
          assigneeName: 'Alex Rivera',
        });
        const b = await store.addDayOff(alice, {
          label: `${tag} Alex Out`,
          startDate: '2026-12-21',
          endDate: '2026-12-31',
          assigneeName: 'Alex Rivera',
        });
        expect(a.id).not.toBe(b.id);
        expect((await mine()).map((e) => e.assigneeName)).toEqual(['Alex Rivera', 'Alex Rivera']);
      });

      it('lists by start date, then end date, then label', async () => {
        const add = (label: string, startDate: string, endDate: string) =>
          store.addDayOff(alice, { label: `${tag} ${label}`, startDate, endDate, assigneeName: null });
        await add('c', '2026-12-24', '2026-12-26');
        await add('b', '2026-12-24', '2026-12-24');
        await add('z', '2026-11-26', '2026-11-26');
        await add('a', '2026-12-24', '2026-12-24');
        expect((await mine()).map((e) => e.label.slice(tag.length + 1))).toEqual(['z', 'a', 'b', 'c']);
      });

      it('shares the calendar between users', async () => {
        const added = await store.addDayOff(alice, {
          label: `${tag} Shutdown`,
          startDate: '2026-12-28',
          endDate: '2026-12-31',
          assigneeName: null,
        });
        // The list takes no user: bob sees alice's entry and can remove it
        expect(await mine()).toEqual([added]);
        expect(await store.deleteDayOff(added.id)).toBe(true);
        expect(await mine()).toEqual([]);
        expect(bob).toBeTruthy();
      });

      it('deletes only the named entry and reports a missing one', async () => {
        const keep = await store.addDayOff(alice, {
          label: `${tag} keep`,
          startDate: '2026-11-26',
          endDate: '2026-11-26',
          assigneeName: null,
        });
        const drop = await store.addDayOff(alice, {
          label: `${tag} drop`,
          startDate: '2026-11-27',
          endDate: '2026-11-27',
          assigneeName: null,
        });
        expect(await store.deleteDayOff(drop.id)).toBe(true);
        expect(await mine()).toEqual([keep]);
        expect(await store.deleteDayOff(drop.id)).toBe(false);
        expect(await store.deleteDayOff('does-not-exist')).toBe(false);
      });

      it('does not let callers mutate stored entries through returned objects', async () => {
        const added = await store.addDayOff(alice, {
          label: `${tag} immutable`,
          startDate: '2026-11-26',
          endDate: '2026-11-26',
          assigneeName: null,
        });
        added.label = 'changed';
        (await mine())[0].label = 'changed too';
        expect((await mine())[0].label).toBe(`${tag} immutable`);
      });
    });
  });
}
