import type { ReactNode } from 'react';
import SingleDatePicker from './SingleDatePicker';

interface Props {
  taskId: string;
  /** Current due date, YYYY-MM-DD */
  value: string;
  title: string;
  color: string;
  minDate?: string | null;
  onChange: (isoDate: string) => void;
  children: ReactNode;
}

/**
 * Due date cell trigger with a single-date calendar popover. Reuses SingleDatePicker.
 */
export default function DueDatePicker({ taskId, value, title, color, minDate, onChange, children }: Props) {
  return (
    <SingleDatePicker
      taskId={taskId}
      kind="due"
      value={value}
      title={title}
      color={color}
      minDate={minDate}
      onChange={onChange}
    >
      {children}
    </SingleDatePicker>
  );
}
