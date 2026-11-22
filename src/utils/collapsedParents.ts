// Per-person display preference, shared by the app and the public shared view. Issue identifiers are
// unique across a workspace, so one key covers every project.
const COLLAPSED_KEY = 'gantt_collapsed_parents';

export function loadCollapsedParents(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsedParents(collapsed: ReadonlySet<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    // Storage unavailable — the collapse still applies for this session
  }
}
