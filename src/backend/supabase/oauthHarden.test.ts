import { describe, expect, it } from 'vitest';
import { generateCodeChallenge, isAllowedRedirectUri } from '../../../supabase/functions/_shared/oauth-utils';

describe('Linear OAuth hardening utilities', () => {
  it('generates RFC 7636 S256 code_challenge matching standard test vector', async () => {
    // RFC 7636 Appendix B test vector:
    // verifier: dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
    // expected challenge: E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = await generateCodeChallenge(verifier);
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  describe('isAllowedRedirectUri', () => {
    const env = {
      linearRedirectUri: 'https://ganttsmart.bluecore.energy/callback',
      allowedOAuthRedirects: 'https://preview.ganttsmart.bluecore.energy/callback',
      allowLocalhost: false,
    };

    it('allows configured production redirect URIs', () => {
      expect(isAllowedRedirectUri('https://ganttsmart.bluecore.energy/callback', env)).toBe(true);
      expect(isAllowedRedirectUri('https://preview.ganttsmart.bluecore.energy/callback', env)).toBe(true);
    });

    it('rejects unlisted production redirect URIs and open redirects', () => {
      expect(isAllowedRedirectUri('https://attacker.com/callback', env)).toBe(false);
      expect(isAllowedRedirectUri('https://ganttsmart.bluecore.energy/evil', env)).toBe(false);
      expect(isAllowedRedirectUri('javascript:alert(1)', env)).toBe(false);
    });

    it('gates localhost and 127.0.0.1 behind allowLocalhost=true', () => {
      // With allowLocalhost = false
      expect(isAllowedRedirectUri('http://localhost:5173/callback', env)).toBe(false);
      expect(isAllowedRedirectUri('http://127.0.0.1:5173/callback', env)).toBe(false);

      // With allowLocalhost = true
      const devEnv = { ...env, allowLocalhost: true };
      expect(isAllowedRedirectUri('http://localhost:5173/callback', devEnv)).toBe(true);
      expect(isAllowedRedirectUri('http://localhost:3000/callback', devEnv)).toBe(true);
      expect(isAllowedRedirectUri('http://127.0.0.1:5173/callback', devEnv)).toBe(true);
      expect(isAllowedRedirectUri('https://localhost:5173/callback', devEnv)).toBe(true);
    });

    it('strictly validates localhost URLs against query, hash, credentials, and path', () => {
      const devEnv = { ...env, allowLocalhost: true };

      // Rejects non-/callback paths
      expect(isAllowedRedirectUri('http://localhost:5173/evil', devEnv)).toBe(false);
      expect(isAllowedRedirectUri('http://localhost:5173/', devEnv)).toBe(false);

      // Rejects query parameters
      expect(isAllowedRedirectUri('http://localhost:5173/callback?foo=bar', devEnv)).toBe(false);

      // Rejects URL hash fragments
      expect(isAllowedRedirectUri('http://localhost:5173/callback#token=123', devEnv)).toBe(false);

      // Rejects embedded credentials
      expect(isAllowedRedirectUri('http://user:pass@localhost:5173/callback', devEnv)).toBe(false);

      // Rejects non-http/https protocols
      expect(isAllowedRedirectUri('ftp://localhost:5173/callback', devEnv)).toBe(false);
    });
  });
});
