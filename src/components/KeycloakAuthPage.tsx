import { useState } from 'react';
import Logo from './Logo';

interface Props {
  onSignIn: () => Promise<void>;
}

export default function KeycloakAuthPage({ onSignIn }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const handleSignIn = async () => {
    setBusy(true);
    setError('');
    try {
      await onSignIn();
    } catch {
      setError('Sign-in is temporarily unavailable. Please try again.');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-bg-primary flex items-center justify-center z-200">
      <div className="bg-bg-card border border-border-secondary rounded-lg shadow-xl p-8 max-w-[440px] w-full text-center">
        <div className="flex justify-center mb-4">
          <Logo size={40} />
        </div>
        <h1 className="text-2xl font-bold text-text-primary mb-1 tracking-tight">GanttSmart</h1>
        <p className="text-[13px] text-text-secondary mb-8 leading-relaxed">Sign in to your account.</p>
        <button
          onClick={handleSignIn}
          disabled={busy}
          aria-busy={busy}
          className="w-full py-2.5 px-4 bg-accent text-white rounded-md text-sm font-medium cursor-pointer flex items-center justify-center gap-2 hover:bg-accent-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <rect x="4" y="10" width="16" height="11" rx="2" />
            <path d="M8 10V6a4 4 0 0 1 8 0v4" />
            <circle cx="12" cy="15" r="1" />
            <path d="M12 16v2" />
          </svg>
          {busy ? 'Redirecting to Keycloak...' : 'Continue with Keycloak'}
        </button>
        {error && (
          <div role="alert" className="text-urgent text-xs mt-4">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
