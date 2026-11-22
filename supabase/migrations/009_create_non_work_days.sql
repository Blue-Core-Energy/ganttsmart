-- Non-work days: company holidays, plant shutdowns and per-person PTO.
-- Dates are inclusive. A NULL assignee_name means the entry applies to everyone.
-- Each Supabase account keeps its own calendar (like task_baselines).

CREATE TABLE public.non_work_days (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200),
  start_date date NOT NULL,
  end_date date NOT NULL,
  assignee_name text CHECK (assignee_name IS NULL OR char_length(assignee_name) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  CHECK (end_date - start_date < 366)
);

ALTER TABLE public.non_work_days ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_own_non_work_days" ON public.non_work_days
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_non_work_days_user ON public.non_work_days (user_id, start_date);
