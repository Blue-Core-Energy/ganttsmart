import { describe, expect, it } from 'vitest';
import { backend } from './index';
import { GCP_SIGN_OUT_URL } from './useGcpAuth';

describe('gcp backend', () => {
  it('enables signOut and disables sharing, passwordLogin, and marketingPages', () => {
    expect(backend.kind).toBe('gcp');
    expect(backend.capabilities).toEqual({
      sharing: false,
      passwordLogin: false,
      marketingPages: false,
      signOut: true,
    });
  });

  it('uses the IAP CLEAR_LOGIN_COOKIE URL for sign-out', () => {
    expect(GCP_SIGN_OUT_URL).toBe('/?gcp-iap-mode=CLEAR_LOGIN_COOKIE');
  });
});
