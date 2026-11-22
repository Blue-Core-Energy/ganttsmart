import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { backend } from '@/backend';
import type { Theme } from '@/hooks/useTheme';
import type { Project } from '@/types';
import { exportAsPng, exportAsPdf } from '@/utils/export';
import { isSafeUrl } from '@/utils/url';
import CustomDropdown from './CustomDropdown';
import type { DropdownOption } from './CustomDropdown';
import FeedbackDialog from './FeedbackDialog';
import { toastError, toastSuccess } from './toastStore';

// Loaded on demand: it pulls in the Supabase client, which only the Supabase backend has
const ShareDialog = lazy(() => import('./ShareDialog'));

interface Props {
  projectName: string;
  loading: boolean;
  lastSynced: string;
  onRefresh: () => void;
  onDisconnectLinear: () => void | Promise<void>;
  onSignOut: () => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  projectId: string;
  projects: Project[];
  onSelectProject: (id: string) => void;
  linearToken?: string;
  linearProjectUrl?: string | null;
  isLinkedInLinear?: boolean;
  linkingToLinear?: boolean;
  onAddToLinear?: () => void;
  /** Opens the Days Off manager; the menu entry is hidden when omitted */
  onOpenDaysOff?: () => void;
  daysOffCount?: number;
}

const iconBtn =
  'flex items-center justify-center w-8 h-8 rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer';

const ghostBtn =
  'flex items-center gap-1.5 px-2 md:px-2.5 h-8 rounded-md text-xs font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer whitespace-nowrap shrink-0';

function FolderIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-text-muted shrink-0"
    >
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function FeedbackIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M12 7v6" />
      <path d="M9 10h6" />
    </svg>
  );
}

function LinkPlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function ExternalLinkIcon({ className = 'shrink-0' }: { className?: string }) {
  return (
    <svg
      width="12"
      height="12"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function CalendarOffIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
      <path d="M9 15l6 4M15 15l-6 4" />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

export default memo(function Header({
  projectName,
  loading,
  lastSynced,
  onRefresh,
  onDisconnectLinear,
  onSignOut,
  theme,
  onThemeChange,
  projectId,
  projects,
  onSelectProject,
  linearToken,
  linearProjectUrl,
  isLinkedInLinear,
  linkingToLinear,
  onAddToLinear,
  onOpenDaysOff,
  daysOffCount = 0,
}: Props) {
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [showFeedbackDialog, setShowFeedbackDialog] = useState(false);
  const [exporting, setExporting] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);

  const projectOptions: DropdownOption[] = useMemo(
    () => projects.map((p) => ({ value: p.id, label: p.name, icon: <FolderIcon /> })),
    [projects],
  );

  // Close menus on outside click or Escape
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (accountRef.current && !accountRef.current.contains(e.target as Node)) setShowAccountMenu(false);
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowAccountMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', keyHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler);
    };
  }, []);

  const handleExport = async (format: 'png' | 'pdf') => {
    setShowAccountMenu(false);
    setExporting(true);
    try {
      const el = document.getElementById('gantt-export-target');
      if (!el) {
        toastError('Nothing to export — load a project first.');
        return;
      }
      if (format === 'png') await exportAsPng(el);
      else await exportAsPdf(el);
      toastSuccess(`Exported as ${format.toUpperCase()}`);
    } catch (e) {
      toastError(`Export failed: ${(e as Error).message}`);
    } finally {
      setExporting(false);
    }
  };

  const toggleTheme = () => {
    onThemeChange(theme === 'dark' ? 'light' : 'dark');
    setShowAccountMenu(false);
  };

  return (
    <header className="h-[52px] shrink-0 border-b border-border-primary bg-bg-header flex items-center px-2.5 sm:px-4 gap-2 sm:gap-3 print:hidden">
      {/* Left: brand + breadcrumb */}
      <div className="flex items-center gap-2 min-w-0">
        <div className="w-7 h-7 rounded-md bg-accent flex items-center justify-center shrink-0">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="4" width="18" height="4" rx="1" />
            <rect x="3" y="11" width="12" height="4" rx="1" />
            <rect x="3" y="18" width="15" height="3" rx="1" />
          </svg>
        </div>
        <span className="hidden sm:inline text-sm font-semibold text-text-primary tracking-tight whitespace-nowrap">
          Ganttsmart
        </span>
        {/* The switcher renders from the project list, not the loaded name, so a project that
            fails to load can still be switched away from */}
        {(projectName || projects.length > 0) && (
          <>
            <span className="hidden sm:inline text-text-muted text-sm">/</span>
            <CustomDropdown
              variant="breadcrumb"
              value={projectId}
              options={projectOptions}
              placeholder={projectName || 'Select project'}
              placeholderIcon={<FolderIcon />}
              onChange={onSelectProject}
              className="min-w-0"
              required
              searchable
              searchPlaceholder="Search projects…"
              emptyMessage="No projects found"
              ariaLabel="Projects"
            />
            <span className="hidden xl:inline text-text-muted text-sm">/</span>
            <span className="hidden xl:inline text-sm text-text-primary font-medium whitespace-nowrap">Roadmap</span>
          </>
        )}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Right: actions */}
      <div className="flex items-center gap-0.5 sm:gap-1 shrink-0">
        {lastSynced && (
          <span className="hidden xl:inline text-[11px] text-text-muted mr-1 whitespace-nowrap shrink-0">
            Synced <span className="font-mono tabular-nums">{lastSynced}</span>
          </span>
        )}

        {/* Refresh */}
        <button onClick={onRefresh} className={ghostBtn} title="Refresh (R)">
          {loading ? (
            <span className="inline-block w-3.5 h-3.5 border-2 border-text-muted border-t-accent rounded-full animate-spin" />
          ) : (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
          )}
          <span className="hidden md:inline">Sync</span>
        </button>

        {/* Share */}
        {backend.capabilities.sharing && (
          <button
            onClick={() => setShowShareDialog(true)}
            className="flex items-center gap-1.5 px-3 h-8 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent-light transition-colors cursor-pointer"
            title="Share roadmap"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="18" cy="5" r="3" />
              <circle cx="6" cy="12" r="3" />
              <circle cx="18" cy="19" r="3" />
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
              <line x1="15.41" y1="6.51" x2="8.59" y2="11.49" />
            </svg>
            Share
          </button>
        )}

        {backend.capabilities.sharing && showShareDialog && (
          <Suspense fallback={null}>
            <ShareDialog projectId={projectId} projectName={projectName} onClose={() => setShowShareDialog(false)} />
          </Suspense>
        )}

        {/* Divider */}
        <div className="w-px h-5 bg-border-primary mx-0.5 sm:mx-1" />

        {/* Feedback */}
        <button
          type="button"
          onClick={() => setShowFeedbackDialog(true)}
          className={ghostBtn}
          aria-label="Feedback"
          title="Feedback"
        >
          <FeedbackIcon />
          <span className="hidden sm:inline">Feedback</span>
        </button>

        {showFeedbackDialog && (
          <FeedbackDialog
            initialType="feature"
            linearToken={linearToken ?? ''}
            projectName={projectName}
            onClose={() => setShowFeedbackDialog(false)}
          />
        )}

        {/* Account menu */}
        <div className="relative" ref={accountRef}>
          <button
            type="button"
            onClick={() => setShowAccountMenu((v) => !v)}
            className={iconBtn}
            title="Account"
            aria-label="Account"
            aria-expanded={showAccountMenu}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </button>
          {showAccountMenu && (
            <div className="absolute top-full mt-1 right-0 bg-bg-card border border-border-secondary rounded-lg shadow-xl z-50 min-w-[220px] py-1">
              {/* Linear project resource link */}
              {projectId && onAddToLinear && (
                <>
                  {isLinkedInLinear ? (
                    isSafeUrl(linearProjectUrl) ? (
                      <a
                        href={linearProjectUrl!}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => setShowAccountMenu(false)}
                        className="w-full text-left px-3 py-2 text-xs text-low hover:bg-bg-hover transition-colors cursor-pointer flex items-center justify-between"
                        aria-label="Open in Linear"
                        title="Linked in Linear — open project in Linear"
                      >
                        <span className="flex items-center gap-2">
                          <CheckCircleIcon />
                          <span>Open in Linear</span>
                        </span>
                        <ExternalLinkIcon className="shrink-0" />
                      </a>
                    ) : (
                      <span
                        className="w-full text-left px-3 py-2 text-xs text-low flex items-center gap-2"
                        aria-label="Linked in Linear"
                        title="Open in GanttSmart link is on this project's Linear page"
                      >
                        <CheckCircleIcon />
                        <span>Linked in Linear</span>
                      </span>
                    )
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setShowAccountMenu(false);
                        onAddToLinear();
                      }}
                      disabled={linkingToLinear || loading}
                      className="w-full text-left px-3 py-2 text-xs text-text-primary hover:bg-bg-hover transition-colors cursor-pointer flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                      aria-label={linkingToLinear ? 'Linking to Linear' : 'Add to Linear'}
                      title="Add an 'Open in GanttSmart' link to this project's Linear page"
                    >
                      {linkingToLinear ? (
                        <span className="inline-block w-3.5 h-3.5 border-2 border-text-muted border-t-accent rounded-full animate-spin shrink-0" />
                      ) : (
                        <LinkPlusIcon />
                      )}
                      <span>{linkingToLinear ? 'Linking…' : 'Add to Linear'}</span>
                    </button>
                  )}
                  <div className="border-t border-border-primary my-0.5" />
                </>
              )}

              {/* Days Off calendar manager */}
              {onOpenDaysOff && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setShowAccountMenu(false);
                      onOpenDaysOff();
                    }}
                    className="w-full text-left px-3 py-2 text-xs text-text-primary hover:bg-bg-hover transition-colors cursor-pointer flex items-center justify-between"
                    title="Manage company-wide closures and one person's time off"
                  >
                    <span className="flex items-center gap-2">
                      <CalendarOffIcon />
                      <span>Days Off</span>
                    </span>
                    {daysOffCount > 0 && (
                      <span className="font-mono tabular-nums text-[11px] text-text-muted">{daysOffCount}</span>
                    )}
                  </button>
                  <div className="border-t border-border-primary my-0.5" />
                </>
              )}

              {/* Export */}
              <div className="px-3 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                Export
              </div>
              <button
                type="button"
                onClick={() => handleExport('png')}
                disabled={exporting}
                className="w-full text-left px-3 py-2 text-xs text-text-primary hover:bg-bg-hover transition-colors cursor-pointer flex items-center justify-between disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span>Export as PNG</span>
                {exporting && (
                  <span className="inline-block w-3 h-3 border-2 border-text-muted border-t-accent rounded-full animate-spin" />
                )}
              </button>
              <button
                type="button"
                onClick={() => handleExport('pdf')}
                disabled={exporting}
                className="w-full text-left px-3 py-2 text-xs text-text-primary hover:bg-bg-hover transition-colors cursor-pointer flex items-center justify-between disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span>Export as PDF</span>
                {exporting && (
                  <span className="inline-block w-3 h-3 border-2 border-text-muted border-t-accent rounded-full animate-spin" />
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowAccountMenu(false);
                  window.print();
                }}
                className="w-full text-left px-3 py-2 text-xs text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
              >
                Print
              </button>

              <div className="border-t border-border-primary my-0.5" />

              {/* Theme toggle */}
              <button
                type="button"
                onClick={toggleTheme}
                className="w-full text-left px-3 py-2 text-xs text-text-primary hover:bg-bg-hover transition-colors cursor-pointer flex items-center justify-between"
                title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              >
                <span className="flex items-center gap-2">
                  {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
                  <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
                </span>
                <span className="text-[11px] text-text-muted capitalize">{theme}</span>
              </button>

              <div className="border-t border-border-primary my-0.5" />

              {/* Account management */}
              <button
                type="button"
                onClick={() => {
                  setShowAccountMenu(false);
                  onDisconnectLinear();
                }}
                className="w-full text-left px-3 py-2 text-xs text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
              >
                Disconnect Linear
              </button>
              {backend.capabilities.signOut !== false && (
                <>
                  <div className="border-t border-border-primary my-0.5" />
                  <button
                    type="button"
                    onClick={() => {
                      setShowAccountMenu(false);
                      onSignOut();
                    }}
                    className="w-full text-left px-3 py-2 text-xs text-urgent hover:bg-bg-hover transition-colors cursor-pointer"
                  >
                    Sign out
                  </button>
                  {backend.kind === 'gcp' && (
                    <p className="px-3 pb-2 text-[11px] text-text-muted leading-snug">
                      Signs out of GanttSmart only, not Google.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
});
