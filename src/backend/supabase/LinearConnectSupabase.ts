const LINEAR_CLIENT_ID = import.meta.env.VITE_LINEAR_CLIENT_ID;
const LINEAR_REDIRECT_URI = import.meta.env.VITE_LINEAR_REDIRECT_URI;

/** Start the Linear OAuth flow; the code is exchanged on /callback. */
export function connectLinear() {
  if (!LINEAR_CLIENT_ID) {
    alert('Linear OAuth Client ID not configured. Set VITE_LINEAR_CLIENT_ID in .env');
    return;
  }

  // Generate state for CSRF protection
  const state = crypto.randomUUID();
  sessionStorage.setItem('linear_oauth_state', state);

  const params = new URLSearchParams({
    client_id: LINEAR_CLIENT_ID,
    redirect_uri: LINEAR_REDIRECT_URI,
    response_type: 'code',
    scope: 'read,write',
    state,
  });

  window.location.href = `https://linear.app/oauth/authorize?${params}`;
}
