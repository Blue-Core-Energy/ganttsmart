import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import FilterBar from '@/components/FilterBar';
import GanttChart from '@/components/GanttChart';
import Legend from '@/components/Legend';
import MilestonePanel from '@/components/MilestonePanel';
import StatsRow from '@/components/StatsRow';
import Tooltip from '@/components/Tooltip';
import { useSharedData } from '@/hooks/useSharedData';
import { useTheme } from '@/hooks/useTheme';
import { formatDate } from '@/utils/date';

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function SharedView() {
  const { shareToken } = useParams<{ shareToken: string }>();
  useTheme();

  const {
    filteredTasks,
    tasks,
    unscheduledTasks,
    milestones,
    projectName,
    cachedAt,
    assignees,
    statuses,
    loading,
    error,
    needsPassword,
    passwordError,
    submitPassword,
    dayWidth,
    setDayWidth,
    timeScale,
    filters,
    setFilters,
    zoomIn,
    zoomOut,
  } = useSharedData(shareToken || '');

  const [password, setPassword] = useState('');

  // Keyboard zoom
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('[role="dialog"]') || document.querySelector('[role="dialog"]')) return;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
      if (e.key === '+' || e.key === '=') zoomIn();
      if (e.key === '-' || e.key === '_') zoomOut();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [zoomIn, zoomOut]);

  // Password prompt
  if (needsPassword) {
    return (
      <div className="min-h-screen bg-bg-primary flex items-center justify-center p-6">
        <div className="bg-bg-card border border-border-secondary rounded-2xl p-8 max-w-sm w-full text-center">
          <div className="w-10 h-10 rounded-lg bg-accent/10 text-accent flex items-center justify-center mx-auto mb-4">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0110 0v4" />
            </svg>
          </div>
          <h2 className="text-lg font-bold text-text-primary mb-1">{projectName || 'Protected Roadmap'}</h2>
          <p className="text-sm text-text-secondary mb-6">
            This roadmap is password-protected. Enter the password to view.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (password.trim()) submitPassword(password.trim());
            }}
          >
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              className="w-full px-4 py-2.5 bg-bg-primary border border-border-secondary rounded-lg text-text-primary text-sm mb-3 outline-none focus:border-accent"
              autoFocus
            />
            {passwordError && <p className="text-xs text-urgent mb-3">{passwordError}</p>}
            <button
              type="submit"
              className="w-full py-2.5 bg-accent text-white text-sm font-semibold rounded-lg hover:bg-accent/90 transition-colors cursor-pointer"
            >
              View Roadmap
            </button>
          </form>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="min-h-screen bg-bg-primary flex items-center justify-center p-6">
        <div className="bg-bg-card border border-border-secondary rounded-2xl p-8 max-w-sm w-full text-center">
          <div className="w-10 h-10 rounded-lg bg-urgent/10 text-urgent flex items-center justify-center mx-auto mb-4">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
          </div>
          <h2 className="text-lg font-bold text-text-primary mb-2">Link Unavailable</h2>
          <p className="text-sm text-text-secondary mb-6">{error}</p>
          <Link
            to="/"
            className="inline-flex px-6 py-2.5 bg-accent text-white text-sm font-semibold rounded-lg hover:bg-accent/90 transition-colors"
          >
            Go to GanttSmart
          </Link>
        </div>
      </div>
    );
  }

  // Loading
  if (loading) {
    return (
      <div className="min-h-screen bg-bg-primary flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-3 border-border-primary border-t-accent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-sm text-text-secondary">Loading shared roadmap...</p>
        </div>
      </div>
    );
  }

  const title = `${projectName} Roadmap`;
  let subtitle = 'No tasks';
  if (filteredTasks.length > 0) {
    subtitle = `${filteredTasks.length} tasks \u00B7 ${formatDate(filteredTasks[0].due)} \u2013 ${formatDate(filteredTasks[filteredTasks.length - 1].due)}`;
  }

  return (
    <div className="min-h-screen bg-bg-primary flex flex-col">
      <div className="flex-1 p-4 sm:p-6 lg:p-10">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-text-primary tracking-tight">{title}</h1>
          <p className="text-sm text-text-secondary mt-1">{subtitle}</p>
          {cachedAt && <p className="text-xs text-text-muted mt-1">Last updated {timeAgo(cachedAt)}</p>}
        </div>

        {/* Filters (no project selector) */}
        <FilterBar
          projects={[]}
          selectedProjectId=""
          onSelectProject={() => {}}
          assignees={assignees}
          statuses={statuses}
          filters={filters}
          onFiltersChange={setFilters}
          totalCount={tasks.length}
          filteredCount={filteredTasks.length}
          hideProjectSelector
        />

        <StatsRow tasks={filteredTasks} />
        <Legend />

        <GanttChart
          tasks={filteredTasks}
          unscheduledTasks={unscheduledTasks}
          milestones={milestones}
          loading={false}
          error=""
          dayWidth={dayWidth}
          onDayWidthChange={setDayWidth}
          timeScale={timeScale}
          projectName={projectName}
        />
        <MilestonePanel />
        <Tooltip />
      </div>

      {/* Footer */}
      <footer className="border-t border-border-primary px-6 py-4 text-center">
        <p className="text-xs text-text-muted">
          Powered by{' '}
          <Link to="/" className="text-accent hover:text-accent/80 font-medium transition-colors">
            GanttSmart
          </Link>{' '}
          \u2014 Gantt charts for Linear
        </p>
      </footer>
    </div>
  );
}
