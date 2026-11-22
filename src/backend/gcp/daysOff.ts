import type { DaysOffApi } from '../types';
import type { DayOff } from '@/types';
import { deleteRequest, getJson, postJsonForJson } from './api';

// The calendar is shared: the server stores one list for everyone behind IAP.
export const daysOff: DaysOffApi = {
  async list() {
    const { daysOff: entries } = await getJson<{ daysOff: DayOff[] }>('/api/days-off');
    return entries;
  },

  async add(entry) {
    const { dayOff } = await postJsonForJson<{ dayOff: DayOff }>('/api/days-off', entry);
    return dayOff;
  },

  async remove(id) {
    await deleteRequest(`/api/days-off/${encodeURIComponent(id)}`);
  },
};
