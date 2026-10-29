import type { Backend } from '../types';
import { apiFetch } from './api';
import { history } from './history';
import { useGcpAuth } from './useGcpAuth';

export const backend: Backend = {
  kind: 'gcp',
  // signOut: IAP's sign-out parameter could not be confirmed, so "Sign out" is hidden.
  capabilities: { sharing: false, passwordLogin: false, marketingPages: false, signOut: false },
  useAuth: useGcpAuth,
  // The server holds the Linear token and relays the request; the token argument is unused.
  linearRequest(_token, body) {
    return apiFetch('/api/linear/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  },
  history,
};
