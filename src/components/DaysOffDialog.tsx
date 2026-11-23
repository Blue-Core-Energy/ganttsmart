import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import type { NewDayOff, DayOff } from '@/types';
import { formatDayOffRange, parseDayOffInput } from '@/utils/daysOff';

interface Props {
  entries: DayOff[];
  /** Names offered for one person's time off (the people on the loaded project); any name can still be typed */
  assignees: string[];
  loaded: boolean;
  /** Whether the calendar is team-wide (true) or private to the signed-in account (false) */
  shared: boolean;
  /** Saves the entry. Rejects with a message to show in the form. */
  onAdd: (entry: NewDayOff) => Promise<void>;
  onRemove: (id: string) => void | Promise<void>;
  onClose: () => void;
}

const inputCls =
  'w-full h-8 px-2.5 bg-bg-primary border border-border-secondary rounded-lg text-text-primary text-xs outline-none focus:border-accent placeholder:text-text-muted';

type Scope = 'company' | 'person';

export default function DaysOffDialog({ entries, assignees, loaded, shared, onAdd, onRemove, onClose }: Props) {
  const [label, setLabel] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [scope, setScope] = useState<Scope>('company');
  const [person, setPerson] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const labelRef = useRef<HTMLInputElement>(null);
  const ids = { label: useId(), start: useId(), end: useId(), scope: useId(), person: useId(), people: useId() };

  // Offer the people on the project plus anyone who already has time off listed
  const people = useMemo(
    () =>
      [...new Set([...assignees, ...entries.map((e) => e.assigneeName ?? '')])]
        .filter((n) => n && n !== 'Unassigned')
        .sort(),
    [assignees, entries],
  );

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    labelRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, []);

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

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    if (scope === 'person' && !person.trim()) {
      setError('Pick or type the person this time off is for.');
      return;
    }
    const parsed = parseDayOffInput({
      label,
      startDate,
      endDate,
      assigneeName: scope === 'person' ? person : null,
    });
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onAdd(parsed.value);
      setLabel('');
      setStartDate('');
      setEndDate('');
      labelRef.current?.focus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const company = entries.filter((e) => !e.assigneeName);
  const perPerson = entries.filter((e) => e.assigneeName);

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Days Off"
        className="bg-bg-card border border-border-secondary rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto m-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-primary">
          <div>
            <h2 className="text-base font-bold text-text-primary">Days Off</h2>
            <p className="text-xs text-text-secondary mt-0.5">
              Days off are skipped when counting workdays and moving tasks.{' '}
              {shared ? 'Everyone on the team sees this shared calendar.' : 'Saved to your account calendar.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-text-muted hover:text-text-primary cursor-pointer text-lg"
          >
            ×
          </button>
        </div>

        <form onSubmit={submit} className="px-6 py-4 border-b border-border-primary flex flex-col gap-3" noValidate>
          <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Add days off</h3>
          <div>
            <label htmlFor={ids.label} className="text-[11px] text-text-muted mb-1 block">
              Name
            </label>
            <input
              id={ids.label}
              ref={labelRef}
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Thanksgiving, Plant shutdown, Alex on vacation…"
              maxLength={200}
              className={inputCls}
            />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label htmlFor={ids.start} className="text-[11px] text-text-muted mb-1 block">
                Start date
              </label>
              <input
                id={ids.start}
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className={inputCls}
              />
            </div>
            <div className="flex-1">
              <label htmlFor={ids.end} className="text-[11px] text-text-muted mb-1 block">
                End date <span className="opacity-70">(optional)</span>
              </label>
              <input
                id={ids.end}
                type="date"
                value={endDate}
                min={startDate || undefined}
                onChange={(e) => setEndDate(e.target.value)}
                className={inputCls}
              />
            </div>
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label htmlFor={ids.scope} className="text-[11px] text-text-muted mb-1 block">
                Applies to
              </label>
              <select
                id={ids.scope}
                value={scope}
                onChange={(e) => setScope(e.target.value as Scope)}
                className={`${inputCls} cursor-pointer`}
              >
                <option value="company">Company-wide</option>
                <option value="person">One person</option>
              </select>
            </div>
            {scope === 'person' && (
              <div className="flex-1">
                <label htmlFor={ids.person} className="text-[11px] text-text-muted mb-1 block">
                  Person
                </label>
                <input
                  id={ids.person}
                  type="text"
                  list={ids.people}
                  value={person}
                  onChange={(e) => setPerson(e.target.value)}
                  placeholder="Assignee name"
                  maxLength={200}
                  className={inputCls}
                />
                <datalist id={ids.people}>
                  {people.map((n) => (
                    <option key={n} value={n} />
                  ))}
                </datalist>
              </div>
            )}
          </div>
          {error && (
            <p role="alert" className="text-xs text-urgent">
              {error}
            </p>
          )}
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-text-muted">
              Tasks that start or end on a new day off move to the next workday.
            </p>
            <button
              type="submit"
              disabled={saving}
              className="shrink-0 h-8 px-4 rounded-lg bg-accent text-white text-xs font-medium hover:bg-accent-light transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Adding…' : 'Add'}
            </button>
          </div>
        </form>

        <div className="px-6 py-4 flex flex-col gap-4" data-testid="days-off-list">
          {!loaded && <p className="text-xs text-text-muted">Loading…</p>}
          {loaded && entries.length === 0 && (
            <p className="text-xs text-text-muted">No days off yet. Weekends are always skipped.</p>
          )}
          <EntryGroup title="Company-wide" entries={company} onRemove={onRemove} />
          <EntryGroup title="Per-person" entries={perPerson} onRemove={onRemove} />
        </div>
      </div>
    </div>
  );
}

function EntryGroup({
  title,
  entries,
  onRemove,
}: {
  title: string;
  entries: DayOff[];
  onRemove: (id: string) => void | Promise<void>;
}) {
  if (entries.length === 0) return null;
  return (
    <section>
      <h3 className="text-[10.5px] uppercase tracking-wider text-text-muted font-semibold mb-1.5">{title}</h3>
      <ul className="flex flex-col gap-1.5">
        {entries.map((e) => (
          <li
            key={e.id}
            data-day-off-entry={e.label}
            className="flex items-center gap-3 px-3 py-2 bg-bg-primary border border-border-primary rounded-lg"
          >
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${e.assigneeName ? 'bg-teal-500' : 'bg-rose-400'}`}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-medium text-text-primary truncate" title={e.label}>
                {e.label}
              </div>
              <div className="text-[11px] text-text-muted truncate">
                {formatDayOffRange(e)}
                {e.assigneeName ? ` · ${e.assigneeName}` : ''}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void onRemove(e.id)}
              aria-label={`Remove ${e.label}`}
              title="Remove"
              className="shrink-0 w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-urgent hover:bg-bg-hover cursor-pointer"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
