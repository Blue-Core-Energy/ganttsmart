import type { NonWorkDaysApi } from '../types';
import type { NonWorkDay } from '@/types';
import { deleteRequest, getJson, postJsonForJson } from './api';

// The calendar is shared: the server stores one list for everyone behind IAP.
export const nonWorkDays: NonWorkDaysApi = {
  async list() {
    const { nonWorkDays: entries } = await getJson<{ nonWorkDays: NonWorkDay[] }>('/api/non-work-days');
    return entries;
  },

  async add(entry) {
    const { nonWorkDay } = await postJsonForJson<{ nonWorkDay: NonWorkDay }>('/api/non-work-days', entry);
    return nonWorkDay;
  },

  async remove(id) {
    await deleteRequest(`/api/non-work-days/${encodeURIComponent(id)}`);
  },
};
