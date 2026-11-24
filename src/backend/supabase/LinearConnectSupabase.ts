import { toastError } from '@/components/toastStore';
import { supabase } from '@/lib/supabase';
import { readProjectParam, savePendingOAuthProject } from '@/utils/projectDeepLink';

const LINEAR_REDIRECT_URI = import.meta.env.VITE_LINEAR_REDIRECT_URI;

let connectInFlight = false;

/** Start the Linear OAuth flow; the code is exchanged on /callback. */
export async function connectLinear(): Promise<void> {
  if (connectInFlight) return;
  connectInFlight = true;
  try {
    // Preserve ?project=<id> across the Linear OAuth redirect
    const project = readProjectParam(window.location.search);
    if (project) savePendingOAuthProject(project);

    const { data, error } = await supabase.functions.invoke('linear-oauth-callback', {
      body: {
        action: 'start',
        redirect_uri: LINEAR_REDIRECT_URI,
      },
    });

    if (error || !data?.authorizeUrl || !data?.state) {
      throw new Error(error?.message || data?.error || 'Failed to initialize Linear OAuth flow');
    }

    sessionStorage.setItem('linear_oauth_state', data.state);
    window.location.href = data.authorizeUrl;
  } catch (err) {
    toastError(`Could not start Linear connection: ${(err as Error).message}`);
  } finally {
    connectInFlight = false;
  }
}
