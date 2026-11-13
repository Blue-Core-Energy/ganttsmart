import { useEffect, useRef, useState } from 'react';
import type { Task } from '@/types';
import { Avatar } from '@/utils/avatar';
import { isSafeUrl } from '@/utils/url';
import { priorityColors, statusDotColors } from '@/utils/colors';
import { formatDateShort } from '@/utils/date';
import { stripMarkdown } from '@/utils/markdown';
import { isTaskDone } from '@/utils/tasks';
import {
  closeDetailPanel,
  getDetailPanelBaselines,
  getDetailPanelExternalEditState,
  getDetailPanelProjectSelectHandler,
  getDetailPanelTask,
  getRemoveRelationHandler,
  registerDetailPanelHandlers,
  subscribeDetailPanelContext,
} from './detailPanelStore';

export default function DetailPanel() {
  const [task, setTask] = useState<Task | null>(null);
  const [visible, setVisible] = useState(false);
  const [, setContextVersion] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    registerDetailPanelHandlers(
      (t: Task) => {
        setTask(t);
        // Trigger animation on next frame
        requestAnimationFrame(() => setVisible(true));
      },
      () => {
        setVisible(false);
        setTimeout(() => setTask(null), 250); // Wait for slide-out animation
      },
    );
    const unsubscribe = subscribeDetailPanelContext(() => setContextVersion((v) => v + 1));
    return () => {
      unsubscribe();
      registerDetailPanelHandlers(null, null);
    };
  }, []);

  // Close on Escape
  useEffect(() => {
    if (!task) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDetailPanel();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [task]);

  // Close on click outside
  useEffect(() => {
    if (!task) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        closeDetailPanel();
      }
    };
    // Delay to prevent the click that opened the panel from closing it
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 50);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handler);
    };
  }, [task]);

  if (!task) return null;

  const currentTask = getDetailPanelTask(task.id) ?? task;
  const selectProject = getDetailPanelProjectSelectHandler();
  const { allowExternalEdits, onToggleExternalEdits } = getDetailPanelExternalEditState();

  const dueDate = new Date(currentTask.due + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysLeft = Math.round((dueDate.getTime() - today.getTime()) / 86400000);
  const isDone = isTaskDone(currentTask);
  const overdue = !isDone && !currentTask.isUnscheduledExternal && daysLeft < 0;
  const desc = currentTask.description ? stripMarkdown(currentTask.description) : '';
  const statusDotColor = statusDotColors[currentTask.statusType] || '#52525b';
  const priorityColor = priorityColors[currentTask.priority] || '#52525b';

  return (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-[150] transition-opacity duration-250 ${visible ? 'bg-black/20 backdrop-blur-[2px]' : 'opacity-0 pointer-events-none'}`}
        onClick={() => closeDetailPanel()}
      />

      {/* Panel — bottom sheet on mobile, side panel on desktop */}
      <div
        ref={panelRef}
        className={`fixed z-[151] bg-bg-card shadow-2xl flex flex-col transition-transform duration-250 ease-out print:hidden
          inset-x-0 bottom-0 max-h-[75vh] rounded-t-2xl border-t border-border-secondary
          md:inset-x-auto md:right-0 md:top-0 md:bottom-0 md:max-h-none md:rounded-none md:border-t-0 md:border-l md:w-[420px] md:max-w-[90vw]
          ${visible ? 'translate-y-0 md:translate-x-0' : 'translate-y-full md:translate-y-0 md:translate-x-full'}`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-primary shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-bold tracking-wide" style={{ color: priorityColor }}>
              {currentTask.id}
            </span>
            <span className="text-[10px] text-text-muted">·</span>
            <span
              className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
              style={{
                backgroundColor: `${priorityColor}18`,
                color: priorityColor,
                border: `1px solid ${priorityColor}30`,
              }}
            >
              {currentTask.priority}
            </span>
            {currentTask.isExternal && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-accent/10 text-accent border border-accent/25 truncate max-w-[140px]">
                {currentTask.projectName || 'External'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <a
              href={isSafeUrl(currentTask.url) ? currentTask.url : '#'}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1.5 rounded-md hover:bg-bg-hover text-text-muted hover:text-accent transition-colors"
              title="Open in Linear"
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
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
            <button
              onClick={() => closeDetailPanel()}
              className="p-1.5 rounded-md hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors cursor-pointer"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content — scrollable */}
        <div className="flex-1 overflow-y-auto">
          {currentTask.isExternal && (
            <div className="mx-5 mt-4 p-3 rounded-lg bg-accent/[0.06] border border-accent/20 flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-text-secondary font-medium">
                  Cross-project issue ·{' '}
                  <span className="text-text-primary font-semibold">{currentTask.projectName || 'No Project'}</span>
                </span>
                <span className="text-[10px] font-medium text-text-muted">
                  {allowExternalEdits ? 'Write mode' : 'Read-only'}
                </span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {currentTask.projectId && selectProject && (
                  <button
                    type="button"
                    onClick={() => {
                      selectProject(currentTask.projectId!);
                      closeDetailPanel();
                    }}
                    className="px-2.5 py-1 rounded-md bg-accent text-white text-[11px] font-medium hover:bg-accent-light transition-colors cursor-pointer"
                  >
                    Open {currentTask.projectName || 'project'}
                  </button>
                )}
                {onToggleExternalEdits && (
                  <button
                    type="button"
                    onClick={() => onToggleExternalEdits(!allowExternalEdits)}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors cursor-pointer ${
                      allowExternalEdits
                        ? 'bg-amber-500/15 border-amber-500/40 text-amber-500'
                        : 'bg-bg-card border-border-secondary text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {allowExternalEdits ? 'Lock external edits' : 'Unlock editing'}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Title section */}
          <div className="px-5 pt-5 pb-4">
            <h2 className="text-base font-semibold text-text-primary leading-snug mb-4">{currentTask.title}</h2>

            {/* Metadata */}
            <div className="space-y-3">
              {/* Status */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-muted">Status</span>
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-text-primary">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: statusDotColor }} />
                  {currentTask.status}
                </span>
              </div>

              {/* Priority */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-muted">Priority</span>
                <span
                  className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full"
                  style={{
                    backgroundColor: `${priorityColor}18`,
                    color: priorityColor,
                    border: `1px solid ${priorityColor}30`,
                  }}
                >
                  {currentTask.priority}
                </span>
              </div>

              {/* Assignee */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-muted">Assignee</span>
                <div className="flex items-center gap-2">
                  <Avatar name={currentTask.assignee} size="sm" />
                  <span className="text-xs font-medium text-text-primary">{currentTask.assignee}</span>
                </div>
              </div>

              {/* Dates */}
              {currentTask.startDate && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-muted">Start Date</span>
                  <span className="text-xs font-medium text-text-primary tabular-nums">
                    {formatDateShort(currentTask.startDate)}
                  </span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-muted">Due Date</span>
                {currentTask.isUnscheduledExternal ? (
                  <span className="text-xs font-medium text-text-muted italic">No due date</span>
                ) : (
                  <span
                    className="text-xs font-medium tabular-nums"
                    style={{
                      color: isDone
                        ? 'var(--color-success)'
                        : overdue
                          ? 'var(--color-urgent)'
                          : daysLeft <= 7
                            ? 'var(--color-high)'
                            : undefined,
                    }}
                  >
                    {formatDateShort(currentTask.due)}
                    <span className="ml-1.5 text-[11px]">
                      ({isDone ? 'Completed' : overdue ? `${Math.abs(daysLeft)}d overdue` : `${daysLeft}d left`})
                    </span>
                  </span>
                )}
              </div>
            </div>

            {/* Baseline drift */}
            {(() => {
              if (currentTask.isExternal) return null;
              const bl = getDetailPanelBaselines().get(currentTask.id);
              if (!bl) return null;
              const actualDue = new Date(currentTask.due + 'T00:00:00');
              const plannedDue = new Date(bl.planned_due + 'T00:00:00');
              const dueDrift = Math.round((actualDue.getTime() - plannedDue.getTime()) / 86400000);
              const actualStart = currentTask.startDate ? new Date(currentTask.startDate + 'T00:00:00') : null;
              const plannedStart = bl.planned_start ? new Date(bl.planned_start + 'T00:00:00') : null;
              const startDrift =
                actualStart && plannedStart
                  ? Math.round((actualStart.getTime() - plannedStart.getTime()) / 86400000)
                  : null;
              if (dueDrift === 0 && (startDrift === null || startDrift === 0)) return null;
              return (
                <div className="mt-3 p-2.5 rounded-lg bg-bg-primary border border-border-primary">
                  <div className="text-[10px] font-medium text-text-muted mb-1.5">Baseline Drift</div>
                  {startDrift !== null && startDrift !== 0 && (
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-text-muted">Start</span>
                      <span style={{ color: startDrift > 0 ? 'var(--color-high)' : 'var(--color-accent)' }}>
                        {formatDateShort(bl.planned_start!)} → {formatDateShort(currentTask.startDate!)}
                        <span className="ml-1 font-semibold">
                          ({startDrift > 0 ? '+' : ''}
                          {startDrift}d)
                        </span>
                      </span>
                    </div>
                  )}
                  {dueDrift !== 0 && (
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-text-muted">Due</span>
                      <span style={{ color: dueDrift > 0 ? 'var(--color-high)' : 'var(--color-accent)' }}>
                        {formatDateShort(bl.planned_due)} → {formatDateShort(currentTask.due)}
                        <span className="ml-1 font-semibold">
                          ({dueDrift > 0 ? '+' : ''}
                          {dueDrift}d)
                        </span>
                      </span>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          {/* Progress */}
          {currentTask.totalChildren > 0 && (
            <div className="px-5 pb-4">
              <div className="p-3 rounded-lg bg-bg-primary border border-border-primary">
                <div className="flex items-center justify-between text-[11px] mb-2">
                  <span className="text-text-muted font-medium">Sub-issue Progress</span>
                  <span className="text-text-secondary font-semibold">
                    {currentTask.completedChildren}/{currentTask.totalChildren} ({currentTask.progress}%)
                  </span>
                </div>
                <div className="h-2 rounded-full bg-border-primary overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${currentTask.progress}%`,
                      background: currentTask.progress === 100 ? 'var(--color-success)' : 'var(--color-accent)',
                    }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Dependencies */}
          {(currentTask.blocks.length > 0 || currentTask.blockedBy.length > 0) && (
            <div className="px-5 pb-4">
              <div className="text-[11px] font-medium text-text-muted mb-2">Dependencies</div>
              <div className="flex flex-wrap gap-1.5">
                {currentTask.blockedBy.map((blockerId) => {
                  const dep = getDetailPanelTask(blockerId);
                  return (
                    <span
                      key={`by-${blockerId}`}
                      title={
                        dep
                          ? `${dep.title}${dep.isExternal ? ` (${dep.projectName || 'External'})` : ''} · ${dep.isUnscheduledExternal ? 'No due date' : formatDateShort(dep.due)}`
                          : undefined
                      }
                      className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-urgent/10 text-urgent border border-urgent/20 font-medium"
                    >
                      Blocked by {blockerId}
                      {dep?.isExternal && (
                        <>
                          {dep.projectId && selectProject ? (
                            <button
                              type="button"
                              onClick={() => {
                                selectProject(dep.projectId!);
                                closeDetailPanel();
                              }}
                              className="px-1 py-0.2 rounded bg-urgent/15 hover:bg-urgent/25 text-[10px] underline underline-offset-2 cursor-pointer"
                              title={`Open ${dep.projectName} project`}
                            >
                              {dep.projectName}
                            </button>
                          ) : (
                            <span className="text-[10px] opacity-80">· {dep.projectName}</span>
                          )}
                          {dep.isUnscheduledExternal && <span className="text-[10px] opacity-75">(unscheduled)</span>}
                        </>
                      )}
                      {getRemoveRelationHandler() && (
                        <button
                          className="ml-0.5 p-0.5 rounded hover:bg-urgent/20 transition-colors cursor-pointer"
                          title={`Remove dependency: ${blockerId} → ${currentTask.id}`}
                          onClick={() => {
                            getRemoveRelationHandler()?.(blockerId, currentTask.id);
                            closeDetailPanel();
                          }}
                        >
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                          >
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      )}
                    </span>
                  );
                })}
                {currentTask.blocks.map((blockedId) => {
                  const dep = getDetailPanelTask(blockedId);
                  return (
                    <span
                      key={`blocks-${blockedId}`}
                      title={
                        dep
                          ? `${dep.title}${dep.isExternal ? ` (${dep.projectName || 'External'})` : ''} · ${dep.isUnscheduledExternal ? 'No due date' : formatDateShort(dep.due)}`
                          : undefined
                      }
                      className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-high/10 text-high border border-high/20 font-medium"
                    >
                      Blocks {blockedId}
                      {dep?.isExternal && (
                        <>
                          {dep.projectId && selectProject ? (
                            <button
                              type="button"
                              onClick={() => {
                                selectProject(dep.projectId!);
                                closeDetailPanel();
                              }}
                              className="px-1 py-0.2 rounded bg-high/15 hover:bg-high/25 text-[10px] underline underline-offset-2 cursor-pointer"
                              title={`Open ${dep.projectName} project`}
                            >
                              {dep.projectName}
                            </button>
                          ) : (
                            <span className="text-[10px] opacity-80">· {dep.projectName}</span>
                          )}
                          {dep.isUnscheduledExternal && <span className="text-[10px] opacity-75">(unscheduled)</span>}
                        </>
                      )}
                      {getRemoveRelationHandler() && (
                        <button
                          className="ml-0.5 p-0.5 rounded hover:bg-high/20 transition-colors cursor-pointer"
                          title={`Remove dependency: ${currentTask.id} → ${blockedId}`}
                          onClick={() => {
                            getRemoveRelationHandler()?.(currentTask.id, blockedId);
                            closeDetailPanel();
                          }}
                        >
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                          >
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      )}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* Divider */}
          <div className="mx-5 border-t border-border-primary" />

          {/* Description */}
          <div className="px-5 py-4">
            <div className="text-[11px] font-medium text-text-muted mb-2.5">Description</div>
            {desc ? (
              <div className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap break-words">{desc}</div>
            ) : (
              <p className="text-xs text-text-muted italic">No description</p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
