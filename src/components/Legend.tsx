import { memo } from 'react';
import { SCHEDULE_STATE_LABELS, SCHEDULE_STATES, scheduleStateClass } from '@/utils/scheduleState';

export default memo(function Legend() {
  return (
    <div className="inline-flex items-center gap-5 mb-8 bg-bg-card/50 border border-border-primary rounded-lg px-4 py-2.5 flex-wrap print:hidden">
      {SCHEDULE_STATES.map((state) => (
        <div key={state} className="flex items-center gap-2 text-[12px] text-text-secondary font-medium">
          <div className={`w-5 h-2 rounded-full bar-swatch ${scheduleStateClass(state)}`} />
          {SCHEDULE_STATE_LABELS[state]}
        </div>
      ))}
      <div className="flex items-center gap-2 text-[12px] text-text-secondary font-medium">
        <div
          className="w-5 h-2 rounded-full"
          style={{
            background: 'color-mix(in srgb, var(--color-accent) 30%, transparent)',
            border: '1px dashed var(--color-accent)',
          }}
        />
        Today
      </div>
    </div>
  );
});
