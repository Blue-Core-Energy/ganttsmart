import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { backend } from '@/backend';
import type { Theme } from '@/hooks/useTheme';
import { TIME_SCALES } from '@/types';
import type { Task, TimeScale } from '@/types';
import { exportAsPng, exportAsPdf } from '@/utils/export';
import type { FeedbackType } from '@/utils/feedback';
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
  onZoomIn: () => void;
  onZoomOut: () => void;
  dayWidth: number;
  timeScale: TimeScale;
  onTimeScaleChange: (scale: TimeScale) => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  projectId: string;
  tasks: Task[];
  linearToken?: string;
}

const iconBtn =
  'flex items-center justify-center w-8 h-8 rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer';

const ghostBtn =
  'flex items-center gap-1.5 px-2.5 h-8 rounded-md text-xs font-medium text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer whitespace-nowrap shrink-0';

function formatRangeLabel(tasks: Task[]): string | null {
  const dates: number[] = [];
  for (const t of tasks) {
    if (t.startDate) {
      const d = new Date(t.startDate).getTime();
      if (!Number.isNaN(d)) dates.push(d);
    }
    if (t.due) {
      const d = new Date(t.due).getTime();
      if (!Number.isNaN(d)) dates.push(d);
    }
  }
  if (dates.length < 2) return null;
  const min = new Date(Math.min(...dates));
  const max = new Date(Math.max(...dates));
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${fmt(min)} – ${fmt(max)}`;
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

function LightbulbIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 18h6" />
      <path d="M10 22h4" />
      <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0018 8 6 6 0 006 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 018.91 14" />
    </svg>
  );
}

function BugIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m8 2 1.88 1.88" />
      <path d="M14.12 3.88 16 2" />
      <path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1" />
      <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6" />
      <path d="M12 20v-9" />
      <path d="M6.53 9C4.6 8.8 3 7.1 3 5" />
      <path d="M6 13H2" />
      <path d="M3 21c0-2.1 1.7-3.9 3.8-4" />
      <path d="M20.97 5c0 2.1-1.6 3.8-3.5 4" />
      <path d="M22 13h-4" />
      <path d="M17.2 17c2.1.1 3.8 1.9 3.8 4" />
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
  onZoomIn,
  onZoomOut,
  dayWidth,
  timeScale,
  onTimeScaleChange,
  theme,
  onThemeChange,
  projectId,
  tasks,
  linearToken,
}: Props) {
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [showFeedbackMenu, setShowFeedbackMenu] = useState(false);
  const [feedbackType, setFeedbackType] = useState<FeedbackType | null>(null);
  const [exporting, setExporting] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);

  // Close menus on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) setShowExportMenu(false);
      if (accountRef.current && !accountRef.current.contains(e.target as Node)) setShowAccountMenu(false);
      if (feedbackRef.current && !feedbackRef.current.contains(e.target as Node)) setShowFeedbackMenu(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const rangeLabel = useMemo(() => formatRangeLabel(tasks), [tasks]);

  const handleExport = async (format: 'png' | 'pdf') => {
    setShowExportMenu(false);
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
        {projectName && (
          <>
            <span className="hidden sm:inline text-text-muted text-sm">/</span>
            <span className="hidden sm:inline text-sm text-text-secondary truncate max-w-[240px]" title={projectName}>
              {projectName}
            </span>
            <span className="hidden xl:inline text-text-muted text-sm">/</span>
            <span className="hidden xl:inline text-sm text-text-primary font-medium whitespace-nowrap">Roadmap</span>
          </>
        )}
      </div>

      {/* Center: sprint/date range badge */}
      {rangeLabel && (
        <div className="hidden lg:flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-bg-hover border border-border-primary text-[11px] font-medium text-text-secondary whitespace-nowrap shrink-0">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          <span className="font-mono tabular-nums">{rangeLabel}</span>
        </div>
      )}

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

        {/* Time scale: Day | Week | Month */}
        <div className="flex items-center h-8 rounded-md bg-bg-hover/50 border border-border-primary p-0.5 gap-0.5 shrink-0">
          {TIME_SCALES.map((s) => (
            <button
              key={s}
              onClick={() => onTimeScaleChange(s)}
              className={`px-1.5 sm:px-2.5 h-[26px] rounded text-[11px] font-medium capitalize transition-colors cursor-pointer ${
                timeScale === s
                  ? 'bg-bg-card text-text-primary shadow-sm'
                  : 'text-text-secondary hover:text-text-primary'
              }`}
              title={`${s.charAt(0).toUpperCase() + s.slice(1)} view`}
              aria-pressed={timeScale === s}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Zoom controls */}
        <div className="hidden sm:flex items-center h-8 rounded-md bg-bg-hover/50 border border-border-primary shrink-0">
          <button onClick={onZoomOut} className={iconBtn} title="Zoom out (−)" style={{ width: 28 }}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <span className="text-[11px] text-text-muted w-7 text-center font-mono tabular-nums">
            {Math.round(dayWidth)}
          </span>
          <button onClick={onZoomIn} className={iconBtn} title="Zoom in (+)" style={{ width: 28 }}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>

        {/* Export */}
        <div className="relative" ref={exportRef}>
          <button
            onClick={() => setShowExportMenu((v) => !v)}
            className={ghostBtn}
            disabled={exporting}
            title="Export roadmap"
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
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span className="hidden md:inline">{exporting ? 'Exporting…' : 'Export'}</span>
          </button>
          {showExportMenu && (
            <div className="absolute top-full mt-1 right-0 bg-bg-card border border-border-secondary rounded-lg shadow-xl z-50 min-w-[160px] py-1">
              <button
                onClick={() => handleExport('png')}
                className="w-full text-left px-3 py-2 text-xs text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
              >
                Export as PNG
              </button>
              <button
                onClick={() => handleExport('pdf')}
                className="w-full text-left px-3 py-2 text-xs text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
              >
                Export as PDF
              </button>
              <div className="border-t border-border-primary my-0.5" />
              <button
                onClick={() => {
                  setShowExportMenu(false);
                  window.print();
                }}
                className="w-full text-left px-3 py-2 text-xs text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
              >
                Print
              </button>
            </div>
          )}
        </div>

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

        {/* Feedback: dedicated buttons on sm+, compact menu on mobile */}
        <div className="hidden sm:flex items-center h-8 rounded-md bg-bg-hover/50 border border-border-primary p-0.5 gap-0.5">
          <button
            type="button"
            onClick={() => setFeedbackType('feature')}
            className="flex items-center gap-1.5 px-2 h-[26px] rounded text-[11px] font-medium text-text-secondary hover:bg-bg-card hover:text-text-primary transition-colors cursor-pointer"
            aria-label="Feature Request"
            title="Feature Request"
          >
            <LightbulbIcon />
            <span className="hidden xl:inline" aria-hidden="true">
              Feature
            </span>
          </button>
          <button
            type="button"
            onClick={() => setFeedbackType('bug')}
            className="flex items-center gap-1.5 px-2 h-[26px] rounded text-[11px] font-medium text-text-secondary hover:bg-bg-card hover:text-text-primary transition-colors cursor-pointer"
            aria-label="Bug Report"
            title="Bug Report"
          >
            <BugIcon />
            <span className="hidden xl:inline" aria-hidden="true">
              Bug
            </span>
          </button>
        </div>

        <div className="relative sm:hidden" ref={feedbackRef}>
          <button
            type="button"
            onClick={() => setShowFeedbackMenu((v) => !v)}
            className={iconBtn}
            aria-label="Send feedback"
            aria-expanded={showFeedbackMenu}
            title="Send feedback"
          >
            <svg
              width="15"
              height="15"
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
          </button>
          {showFeedbackMenu && (
            <div className="absolute top-full mt-1 right-0 bg-bg-card border border-border-secondary rounded-lg shadow-xl z-50 min-w-[168px] py-1">
              <button
                type="button"
                onClick={() => {
                  setShowFeedbackMenu(false);
                  setFeedbackType('feature');
                }}
                className="w-full text-left px-3 py-2 text-xs text-text-primary hover:bg-bg-hover transition-colors cursor-pointer flex items-center gap-2"
              >
                <LightbulbIcon size={13} />
                Feature Request
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowFeedbackMenu(false);
                  setFeedbackType('bug');
                }}
                className="w-full text-left px-3 py-2 text-xs text-text-primary hover:bg-bg-hover transition-colors cursor-pointer flex items-center gap-2"
              >
                <BugIcon size={13} />
                Bug Report
              </button>
            </div>
          )}
        </div>

        {feedbackType && (
          <FeedbackDialog
            initialType={feedbackType}
            linearToken={linearToken ?? ''}
            projectName={projectName}
            onClose={() => setFeedbackType(null)}
          />
        )}

        {/* Divider */}
        <div className="w-px h-5 bg-border-primary mx-1" />

        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          className={iconBtn}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>

        {/* Account menu */}
        <div className="relative" ref={accountRef}>
          <button onClick={() => setShowAccountMenu((v) => !v)} className={iconBtn} title="Account">
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
              <button
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
