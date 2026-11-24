import type { Backend } from '../types';
import { history } from './history';
import { daysOff } from './daysOff';
import { useSupabaseAuth } from './useSupabaseAuth';

const LINEAR_API = 'https://api.linear.app/graphql';

const keycloakLogin = import.meta.env.VITE_AUTH_MODE === 'keycloak';

export const backend: Backend = {
  kind: 'supabase',
  capabilities: {
    sharing: true,
    passwordLogin: !keycloakLogin,
    marketingPages: true,
    sharedDaysOff: false,
    keycloakLogin,
  },
  useAuth: useSupabaseAuth,
  linearRequest(token, body) {
    return fetch(LINEAR_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify(body),
    });
  },
  history,
  daysOff,
};
