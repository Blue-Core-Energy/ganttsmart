import type { Backend } from '../types';
import { history } from './history';
import { useSupabaseAuth } from './useSupabaseAuth';

const LINEAR_API = 'https://api.linear.app/graphql';

export const backend: Backend = {
  kind: 'supabase',
  capabilities: { sharing: true, passwordLogin: true, marketingPages: true },
  useAuth: useSupabaseAuth,
  linearRequest(token, body) {
    return fetch(LINEAR_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify(body),
    });
  },
  history,
};
