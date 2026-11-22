import { useCallback, useEffect, useState } from 'react';
import { backend } from '@/backend';
import { toastError } from '@/components/toastStore';
import type { NewNonWorkDay, NonWorkDay } from '@/types';
import { sortNonWorkDays } from '@/utils/nonWorkDays';

/**
 * The shared holidays / PTO calendar. Loaded once, then again whenever the tab becomes visible so
 * entries a teammate added show up without a reload.
 */
export function useNonWorkDays() {
  const [entries, setEntries] = useState<NonWorkDay[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let warned = false;
    const load = async () => {
      try {
        const next = await backend.nonWorkDays.list();
        if (!cancelled) setEntries(sortNonWorkDays(next));
      } catch (e) {
        if (!cancelled && !warned) {
          warned = true;
          toastError(`Failed to load holidays / PTO: ${(e as Error).message}`);
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
  const add = useCallback(async (entry: NewNonWorkDay): Promise<NonWorkDay> => {
    const added = await backend.nonWorkDays.add(entry);
    setEntries((prev) => sortNonWorkDays([...prev.filter((e) => e.id !== added.id), added]));
    return added;
  }, []);

  /** Removes an entry right away, putting it back if the backend refuses. */
  const remove = useCallback(async (id: string): Promise<void> => {
    let removed: NonWorkDay | undefined;
    setEntries((prev) => {
      removed = prev.find((e) => e.id === id);
      return prev.filter((e) => e.id !== id);
    });
    try {
      await backend.nonWorkDays.remove(id);
    } catch (e) {
      const restore = removed;
      if (restore) setEntries((prev) => sortNonWorkDays([...prev, restore]));
      toastError(`Failed to remove entry: ${(e as Error).message}`);
    }
  }, []);

  return { entries, loaded, add, remove };
}
