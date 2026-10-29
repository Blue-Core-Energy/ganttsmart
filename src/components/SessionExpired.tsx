const DEFAULT_MESSAGE = 'Your session expired. Reload to sign in again.';

/**
 * Shown when there is no signed-in user and no sign-in form (behind IAP): a full reload goes back
 * through sign-in. `message` replaces the default when the cause was not an expired session.
 */
export default function SessionExpired({ message = DEFAULT_MESSAGE }: { message?: string }) {
  return (
    <div className="fixed inset-0 bg-bg-primary flex items-center justify-center z-200">
      <div className="bg-bg-card border border-border-secondary rounded-2xl p-10 max-w-[480px] w-full text-center">
        <p className="text-[15px] text-text-primary mb-6 leading-relaxed">{message}</p>
        <button
          onClick={() => window.location.reload()}
          className="py-2.5 px-6 bg-accent border-none rounded-lg text-white text-sm font-semibold cursor-pointer hover:bg-accent-light transition-colors"
        >
          Reload
        </button>
      </div>
    </div>
  );
}
