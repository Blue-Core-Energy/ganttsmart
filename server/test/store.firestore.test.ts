import { Firestore } from '@google-cloud/firestore';
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
