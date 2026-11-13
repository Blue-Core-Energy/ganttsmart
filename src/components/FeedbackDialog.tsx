import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createFeedbackIssue, FeedbackTargetNotFoundError, type CreatedLinearIssue } from '@/api/linear';
import { backend } from '@/backend';
import {
  buildLinearNewIssueUrl,
  collectSafeAppContext,
  feedbackLabelName,
  formatBugReportMarkdown,
  formatFeatureRequestMarkdown,
  getFeedbackConfig,
  type FeedbackType,
} from '@/utils/feedback';
import { isSafeUrl } from '@/utils/url';
import { toastSuccess } from './toastStore';

interface Props {
  initialType: FeedbackType;
  linearToken: string;
  projectName?: string;
  onClose: () => void;
}

const inputCls =
  'w-full px-3 py-2 bg-bg-primary border border-border-secondary rounded-lg text-text-primary text-xs outline-none focus:border-accent placeholder:text-text-muted';

const textareaCls = `${inputCls} resize-y leading-relaxed`;

export default function FeedbackDialog({ initialType, linearToken, projectName, onClose }: Props) {
  const [type, setType] = useState<FeedbackType>(initialType);
  const [title, setTitle] = useState('');
  const [tryingToDo, setTryingToDo] = useState('');
  const [gettingInTheWay, setGettingInTheWay] = useState('');
  const [wouldHelp, setWouldHelp] = useState('');
  const [whatHappened, setWhatHappened] = useState('');
  const [stepsToReproduce, setStepsToReproduce] = useState('');
  const [expectedBehavior, setExpectedBehavior] = useState('');
  const [includeContext, setIncludeContext] = useState(true);

  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<{ message: string; targetMissing: boolean } | null>(null);
  const [createdIssue, setCreatedIssue] = useState<CreatedLinearIssue | null>(null);

  const titleInputRef = useRef<HTMLInputElement>(null);
  const config = useMemo(() => getFeedbackConfig(), []);

  useEffect(() => {
    titleInputRef.current?.focus();
  }, [type]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const buildDescription = (): string => {
    if (type === 'feature') {
      return formatFeatureRequestMarkdown({
        tryingToDo,
        gettingInTheWay,
        wouldHelp,
      });
    }
    return formatBugReportMarkdown({
      whatHappened,
      stepsToReproduce,
      expectedBehavior,
      includeContext,
      appContext: includeContext
        ? collectSafeAppContext({
            backendMode: backend.kind,
            projectName,
          })
        : undefined,
    });
  };

  const fallbackNewIssueUrl = buildLinearNewIssueUrl({
    workspaceSlug: config.workspaceSlug,
    teamKey: config.teamKey,
    title,
    description: buildDescription(),
    labelName: feedbackLabelName(type),
  });

  const handleTabChange = (nextType: FeedbackType) => {
    setType(nextType);
    setValidationError(null);
    setSubmitError(null);
    setCreatedIssue(null);
  };

  const handleReset = () => {
    setTitle('');
    setTryingToDo('');
    setGettingInTheWay('');
    setWouldHelp('');
    setWhatHappened('');
    setStepsToReproduce('');
    setExpectedBehavior('');
    setValidationError(null);
    setSubmitError(null);
    setCreatedIssue(null);
    requestAnimationFrame(() => titleInputRef.current?.focus());
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setValidationError('Please enter a title.');
      titleInputRef.current?.focus();
      return;
    }

    setValidationError(null);
    setSubmitError(null);

    if (!linearToken) {
      setSubmitError({
        message: 'Linear is not connected. Open Linear below to submit your feedback directly.',
        targetMissing: true,
      });
      return;
    }

    setSubmitting(true);
    try {
      const description = buildDescription();
      const issue = await createFeedbackIssue({
        apiKey: linearToken,
        type,
        title: trimmedTitle,
        description,
      });
      setCreatedIssue(issue);
      const issueUrl = isSafeUrl(issue.url) ? issue.url : config.projectUrl;
      toastSuccess(`Created ${issue.identifier} in Linear`, {
        label: `Open ${issue.identifier} ↗`,
        href: issueUrl,
      });
    } catch (err) {
      const targetMissing = err instanceof FeedbackTargetNotFoundError;
      const message = err instanceof Error ? err.message : 'Failed to create Linear issue.';
      setSubmitError({ message, targetMissing });
    } finally {
      setSubmitting(false);
    }
  };

  const createdUrl = createdIssue && isSafeUrl(createdIssue.url) ? createdIssue.url : config.projectUrl;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-dialog-title"
        className="bg-bg-card border border-border-secondary rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-primary shrink-0">
          <div>
            <h2 id="feedback-dialog-title" className="text-base font-bold text-text-primary">
              Send Feedback
            </h2>
            <p className="text-xs text-text-secondary mt-0.5">
              Files directly to {config.projectName} ({config.teamKey}) in Linear
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close feedback dialog"
            className="w-7 h-7 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer text-lg leading-none"
          >
            ×
          </button>
        </div>

        {/* Mode toggle */}
        <div className="px-6 pt-4 shrink-0">
          <div
            role="tablist"
            aria-label="Feedback type"
            className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-bg-primary border border-border-primary"
          >
            <button
              type="button"
              role="tab"
              aria-selected={type === 'feature'}
              onClick={() => handleTabChange('feature')}
              className={`flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                type === 'feature'
                  ? 'bg-accent text-white shadow-sm'
                  : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover/60'
              }`}
            >
              <svg
                width="13"
                height="13"
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
              Feature Request
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={type === 'bug'}
              onClick={() => handleTabChange('bug')}
              className={`flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                type === 'bug'
                  ? 'bg-accent text-white shadow-sm'
                  : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover/60'
              }`}
            >
              <svg
                width="13"
                height="13"
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
              Bug Report
            </button>
          </div>
        </div>

        {/* Body */}
        {createdIssue ? (
          <div className="px-6 py-6 flex flex-col gap-4 overflow-y-auto">
            <div className="rounded-xl border border-success/30 bg-success/10 p-4 flex items-start gap-3">
              <span className="w-6 h-6 rounded-full bg-success text-white flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">
                ✓
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-text-primary">
                  {type === 'feature' ? 'Feature request' : 'Bug report'} submitted
                </p>
                <p className="text-xs text-text-secondary mt-1 break-words">
                  <span className="font-mono font-semibold text-text-primary">{createdIssue.identifier}</span> —{' '}
                  {createdIssue.title}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <a
                href={createdUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 min-w-[180px] inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-accent text-white text-xs font-semibold hover:bg-accent-light transition-colors"
              >
                Open {createdIssue.identifier} in Linear ↗
              </a>
              <button
                type="button"
                onClick={handleReset}
                className="px-3.5 py-2 rounded-lg border border-border-secondary bg-bg-hover/60 text-xs font-medium text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
              >
                Submit another
              </button>
              <button
                type="button"
                onClick={onClose}
                className="px-3.5 py-2 rounded-lg text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="px-6 py-4 flex flex-col gap-3.5 overflow-y-auto" noValidate>
            <div>
              <label htmlFor="feedback-title" className="text-[11px] font-medium text-text-secondary mb-1 block">
                Title <span className="text-urgent">*</span>
              </label>
              <input
                ref={titleInputRef}
                id="feedback-title"
                type="text"
                required
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  if (validationError) setValidationError(null);
                }}
                placeholder={
                  type === 'feature' ? 'e.g., Export milestones to CSV' : 'e.g., Task bar drags past project end date'
                }
                className={inputCls}
              />
              {validationError && <p className="text-[11px] text-urgent mt-1">{validationError}</p>}
            </div>

            {type === 'feature' ? (
              <>
                <div>
                  <label htmlFor="feedback-trying" className="text-[11px] font-medium text-text-secondary mb-1 block">
                    What are you trying to do?
                  </label>
                  <textarea
                    id="feedback-trying"
                    rows={2}
                    value={tryingToDo}
                    onChange={(e) => setTryingToDo(e.target.value)}
                    placeholder="Describe the workflow or goal..."
                    className={textareaCls}
                  />
                </div>
                <div>
                  <label htmlFor="feedback-way" className="text-[11px] font-medium text-text-secondary mb-1 block">
                    What gets in the way?
                  </label>
                  <textarea
                    id="feedback-way"
                    rows={2}
                    value={gettingInTheWay}
                    onChange={(e) => setGettingInTheWay(e.target.value)}
                    placeholder="Describe the friction or limitation..."
                    className={textareaCls}
                  />
                </div>
                <div>
                  <label htmlFor="feedback-help" className="text-[11px] font-medium text-text-secondary mb-1 block">
                    What would help?
                  </label>
                  <textarea
                    id="feedback-help"
                    rows={3}
                    value={wouldHelp}
                    onChange={(e) => setWouldHelp(e.target.value)}
                    placeholder="Describe the ideal solution or capability..."
                    className={textareaCls}
                  />
                </div>
              </>
            ) : (
              <>
                <div>
                  <label htmlFor="feedback-happened" className="text-[11px] font-medium text-text-secondary mb-1 block">
                    What happened?
                  </label>
                  <textarea
                    id="feedback-happened"
                    rows={2}
                    value={whatHappened}
                    onChange={(e) => setWhatHappened(e.target.value)}
                    placeholder="Describe the bug or unexpected behavior..."
                    className={textareaCls}
                  />
                </div>
                <div>
                  <label htmlFor="feedback-steps" className="text-[11px] font-medium text-text-secondary mb-1 block">
                    Steps to reproduce
                  </label>
                  <textarea
                    id="feedback-steps"
                    rows={3}
                    value={stepsToReproduce}
                    onChange={(e) => setStepsToReproduce(e.target.value)}
                    placeholder="1. Open project...&#10;2. Click..."
                    className={textareaCls}
                  />
                </div>
                <div>
                  <label htmlFor="feedback-expected" className="text-[11px] font-medium text-text-secondary mb-1 block">
                    Expected behavior
                  </label>
                  <textarea
                    id="feedback-expected"
                    rows={2}
                    value={expectedBehavior}
                    onChange={(e) => setExpectedBehavior(e.target.value)}
                    placeholder="What should have happened instead?"
                    className={textareaCls}
                  />
                </div>
                <label className="flex items-start gap-2 text-xs text-text-secondary cursor-pointer select-none pt-0.5">
                  <input
                    id="feedback-include-context"
                    type="checkbox"
                    checked={includeContext}
                    onChange={(e) => setIncludeContext(e.target.checked)}
                    className="mt-0.5 accent-accent cursor-pointer"
                  />
                  <span>Include non-sensitive app context (route, viewport, backend mode)</span>
                </label>
              </>
            )}

            {submitError && (
              <div
                role="alert"
                className="rounded-lg border border-urgent/30 bg-urgent/10 p-3 flex flex-col gap-2 text-xs"
              >
                <p className="text-urgent font-medium">{submitError.message}</p>
                <p className="text-text-secondary text-[11px]">
                  {submitError.targetMissing
                    ? 'You can still file this feedback directly in Linear using the pre-filled form or project link:'
                    : 'You can retry submitting or open Linear directly:'}
                </p>
                <div className="flex flex-wrap gap-2 pt-0.5">
                  <a
                    href={fallbackNewIssueUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-accent text-white text-[11px] font-semibold hover:bg-accent-light transition-colors"
                  >
                    Open pre-filled issue in Linear ↗
                  </a>
                  <a
                    href={config.projectUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-border-secondary bg-bg-card text-text-primary text-[11px] font-medium hover:bg-bg-hover transition-colors"
                  >
                    Open {config.projectName} project ↗
                  </a>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between gap-2 pt-2 border-t border-border-primary">
              <a
                href={config.projectUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] text-text-muted hover:text-text-secondary transition-colors"
              >
                Open {config.projectName} in Linear ↗
              </a>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-3 py-2 rounded-lg text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 rounded-lg bg-accent text-white text-xs font-semibold hover:bg-accent-light transition-colors cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  {submitting && (
                    <span className="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  )}
                  {submitting ? 'Submitting…' : type === 'feature' ? 'Submit Feature Request' : 'Submit Bug Report'}
                </button>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
