import { Firestore } from '@google-cloud/firestore';
import { afterAll, describe, expect, it } from 'vitest';
import { createFirestoreStore } from '../src/store/firestore.js';
import { runStoreContract } from './store.contract.js';

// Runs only against the Firestore emulator (FIRESTORE_EMULATOR_HOST set), never a real project.
const emulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
let db: Firestore | null = null;

runStoreContract(
  'firestore',
  () => {
    db ??= new Firestore({ projectId: 'ganttsmart-test' });
    return createFirestoreStore(db);
  },
  emulator,
);

describe('createFirestoreStore.addBaselinesIfAbsent concurrency', () => {
  it('bounds concurrent creates to at most 20 and ignores ALREADY_EXISTS', async () => {
    let active = 0;
    let maxActive = 0;
    const mockDoc = (id: string) => ({
      create: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        if (id === 'ISS-duplicate') {
          const err = new Error('already exists');
          (err as unknown as { code: number }).code = 6;
          throw err;
        }
      },
    });

    const mockDb = {
      collection: () => ({
        doc: () => ({
          collection: () => ({
            doc: (id: string) => mockDoc(id),
          }),
        }),
      }),
    } as unknown as Firestore;

    const store = createFirestoreStore(mockDb);
    const rows = Array.from({ length: 60 }, (_, i) => ({
      issue_id: i === 0 ? 'ISS-duplicate' : `ISS-${i}`,
      planned_start: null,
      planned_due: '2026-11-21',
    }));

    await store.addBaselinesIfAbsent('sub-1', 'proj-1', rows);
    expect(maxActive).toBe(20);
    expect(active).toBe(0);
  });
});

describe('createFirestoreStore.addBaselinesIfAbsent errors', () => {
  it('propagates a non-ALREADY_EXISTS error and stops picking up remaining rows', async () => {
    let started = 0;
    const mockDb = {
      collection: () => ({
        doc: () => ({
          collection: () => ({
            doc: (id: string) => ({
              create: async () => {
                started++;
                await new Promise((r) => setTimeout(r, 5));
                if (id === 'ISS-0') {
                  const err = new Error('permission denied');
                  (err as unknown as { code: number }).code = 7;
                  throw err;
                }
              },
            }),
          }),
        }),
      }),
    } as unknown as Firestore;

    const store = createFirestoreStore(mockDb);
    const rows = Array.from({ length: 200 }, (_, i) => ({
      issue_id: `ISS-${i}`,
      planned_start: null,
      planned_due: '2026-11-21',
    }));

    await expect(store.addBaselinesIfAbsent('sub-1', 'proj-1', rows)).rejects.toThrow('permission denied');
    // Only the first wave of concurrent creates ran; workers stopped before the remaining rows.
    expect(started).toBeLessThanOrEqual(20);
  });
});

// Close the client's gRPC channels so the run exits instead of hanging on open handles.
afterAll(async () => {
  await db?.terminate();
});
