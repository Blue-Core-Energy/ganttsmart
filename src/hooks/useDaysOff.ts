import { useCallback, useEffect, useState } from 'react';
import { backend } from '@/backend';
import { toastError } from '@/components/toastStore';
import type { NewDayOff, DayOff } from '@/types';
import { sortDaysOff } from '@/utils/daysOff';

/**
 * The days off calendar. Loaded once, then again whenever the tab becomes visible so entries
 * a teammate added show up without a reload. Teammates share it only when
 * `backend.capabilities.sharedDaysOff` is true (GCP); on Supabase each account has its own.
 */
export function useDaysOff() {
  const [entries, setEntries] = useState<DayOff[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let warned = false;
    const load = async () => {
      try {
        const next = await backend.daysOff.list();
        if (!cancelled) setEntries(sortDaysOff(next));
      } catch (e) {
        if (!cancelled && !warned) {
          warned = true;
          toastError(`Failed to load days off: ${(e as Error).message}`);
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    };
    void load();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  /** Saves a new entry and returns it. Throws the backend's message if it cannot be saved. */
  const add = useCallback(async (entry: NewDayOff): Promise<DayOff> => {
    const added = await backend.daysOff.add(entry);
    setEntries((prev) => sortDaysOff([...prev.filter((e) => e.id !== added.id), added]));
    return added;
  }, []);

  /** Removes an entry right away, putting it back if the backend refuses. */
  const remove = useCallback(async (id: string): Promise<void> => {
    let removed: DayOff | undefined;
    setEntries((prev) => {
      removed = prev.find((e) => e.id === id);
      return prev.filter((e) => e.id !== id);
    });
    try {
      await backend.daysOff.remove(id);
    } catch (e) {
      const restore = removed;
      if (restore) setEntries((prev) => sortDaysOff([...prev, restore]));
      toastError(`Failed to remove entry: ${(e as Error).message}`);
    }
  }, []);

  return { entries, loaded, add, remove };
}
