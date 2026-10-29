import { createMemoryStore } from '../src/store/memory.js';
import { runStoreContract } from './store.contract.js';

runStoreContract('memory', () => createMemoryStore());
