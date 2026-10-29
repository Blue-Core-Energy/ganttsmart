import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import '@/index.css';
import App from '@/App';
import { backend } from '@/backend';
import ErrorBoundary from '@/components/ErrorBoundary';

const Landing = lazy(() => import('@/pages/Landing'));
const Callback = lazy(() => import('@/pages/Callback'));
const NotFound = lazy(() => import('@/pages/NotFound'));
const SharedView = lazy(() => import('@/pages/SharedView'));
const PrivacyPolicy = lazy(() => import('@/pages/PrivacyPolicy'));
const TermsOfService = lazy(() => import('@/pages/TermsOfService'));

const { capabilities } = backend;

const Spinner = () => (
  <div className="fixed inset-0 bg-bg-primary flex items-center justify-center">
    <div className="w-10 h-10 border-3 border-border-primary border-t-accent rounded-full animate-spin" />
  </div>
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ErrorBoundary>
        <Suspense fallback={<Spinner />}>
          <Routes>
            {capabilities.marketingPages ? (
              <>
                <Route path="/" element={<Landing />} />
                <Route path="/privacy-policy" element={<PrivacyPolicy />} />
                <Route path="/terms-of-service" element={<TermsOfService />} />
              </>
            ) : (
              <Route path="/" element={<Navigate to="/app" replace />} />
            )}
            <Route path="/app" element={<App />} />
            {/* Supabase's Linear OAuth redirect; the GCP server handles its own callback under /api */}
            {backend.kind === 'supabase' && <Route path="/callback" element={<Callback />} />}
            {capabilities.sharing && <Route path="/share/:shareToken" element={<SharedView />} />}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </BrowserRouter>
  </StrictMode>,
);
