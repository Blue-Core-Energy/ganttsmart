import { FieldValue, type DocumentReference, type Firestore } from '@google-cloud/firestore';
import type { Baseline, ChangeEvent, LinearTokens, Store } from './types.js';

/** gRPC status code Firestore returns from create() when the document already exists. */
const ALREADY_EXISTS = 6;

interface UserDoc {
  email?: string;
  linear?: LinearTokens | null;
}

interface BaselineDoc extends Baseline {
  project_id: string;
}

interface ChangeDoc extends ChangeEvent {
  project_id: string;
  /** `changed_at` plus a per-process sequence, so same-millisecond writes from one instance order deterministically. */
  sort_key: string;
}

function toTokens(value: LinearTokens | null | undefined): LinearTokens | null {
  if (!value) return null;
  return { accessToken: value.accessToken, refreshToken: value.refreshToken, expiresAt: value.expiresAt };
}

function isAlreadyExists(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === ALREADY_EXISTS;
}

/**
 * Firestore-backed Store. Layout:
 * - users/{sub}: { email, linear: LinearTokens | null, updatedAt }
 * - users/{sub}/baselines/{issueId}
 * - users/{sub}/issueChanges/{issueId}/events/{auto} (keyed by issue so ordering needs no composite index)
 * - users/{sub}/transitions/{auto}
 */
export function createFirestoreStore(db: Firestore): Store {
  let seq = 0;
  const userRef = (sub: string): DocumentReference => db.collection('users').doc(sub);
  const eventsRef = (sub: string, issueId: string) =>
    userRef(sub).collection('issueChanges').doc(issueId).collection('events');

  return {
    async getTokens(sub) {
      const snap = await userRef(sub).get();
      return toTokens((snap.data() as UserDoc | undefined)?.linear);
    },

    async saveTokens(sub, email, tokens) {
      await userRef(sub).set(
        { email, linear: toTokens(tokens), updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    },

    async clearTokens(sub) {
      await userRef(sub).set({ linear: null, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    },

    async swapTokens(sub, expectedRefreshToken, next) {
      const ref = userRef(sub);
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const stored = toTokens((snap.data() as UserDoc | undefined)?.linear);
        if (stored === null) return toTokens(next) as LinearTokens;
        if (stored.refreshToken !== expectedRefreshToken) return stored;
        tx.update(ref, { linear: toTokens(next), updatedAt: FieldValue.serverTimestamp() });
        return toTokens(next) as LinearTokens;
      });
    },

    async listBaselines(sub, projectId) {
      const snap = await userRef(sub).collection('baselines').where('project_id', '==', projectId).get();
      return snap.docs.map((doc) => {
        const d = doc.data() as BaselineDoc;
        return {
          issue_id: d.issue_id,
          planned_start: d.planned_start,
          planned_due: d.planned_due,
          first_seen_at: d.first_seen_at,
        };
      });
    },

    async addBaselinesIfAbsent(sub, projectId, rows) {
      const collection = userRef(sub).collection('baselines');
      const now = new Date().toISOString();
      await Promise.all(
        rows.map(async (row) => {
          const doc: BaselineDoc = {
            issue_id: row.issue_id,
            planned_start: row.planned_start,
            planned_due: row.planned_due,
            first_seen_at: now,
            project_id: projectId,
          };
          try {
            await collection.doc(row.issue_id).create(doc);
          } catch (err) {
            if (!isAlreadyExists(err)) throw err;
          }
        }),
      );
    },

    async addChange(sub, change) {
      const changedAt = new Date().toISOString();
      seq += 1;
      const doc: ChangeDoc = {
        issue_id: change.issueId,
        field_changed: change.field,
        old_value: change.oldValue,
        new_value: change.newValue,
        changed_at: changedAt,
        project_id: change.projectId,
        sort_key: `${changedAt}#${String(seq).padStart(15, '0')}`,
      };
      await eventsRef(sub, change.issueId).add(doc);
    },

    async listChanges(sub, issueId, limit) {
      if (limit <= 0) return [];
      const snap = await eventsRef(sub, issueId).orderBy('sort_key', 'desc').limit(limit).get();
      return snap.docs.map((doc) => {
        const d = doc.data() as ChangeDoc;
        return {
          issue_id: d.issue_id,
          field_changed: d.field_changed,
          old_value: d.old_value,
          new_value: d.new_value,
          changed_at: d.changed_at,
        };
      });
    },

    async addTransition(sub, t) {
      await userRef(sub).collection('transitions').add({
        project_id: t.projectId,
        issue_id: t.issueId,
        from_status: t.fromStatus,
        to_status: t.toStatus,
        transitioned_at: new Date().toISOString(),
      });
    },
  };
}
