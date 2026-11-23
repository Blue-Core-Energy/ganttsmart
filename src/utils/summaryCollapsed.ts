// Per-person display preference, shared by the app and the public shared view. Expanded by default.
const SUMMARY_COLLAPSED_KEY = 'gantt_summary_collapsed';

export function loadSummaryCollapsed(): boolean {
  try {
    return localStorage.getItem(SUMMARY_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveSummaryCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SUMMARY_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Storage unavailable — the choice still applies for this session
  }
}
