import { describe, expect, it, vi } from 'vitest';

// The real Supabase client needs VITE_SUPABASE_* at import time; this test only checks the alias wiring.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { backend } from '@/backend';

describe('@/backend', () => {
  it('resolves @/backend/impl to the Supabase backend under the default config', () => {
    expect(backend.kind).toBe('supabase');
    expect(backend.capabilities).toEqual({ sharing: true, passwordLogin: true, marketingPages: true });
  });
});
