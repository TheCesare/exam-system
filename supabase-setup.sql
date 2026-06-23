-- Exam Supervisor System - Supabase Setup SQL
-- Run this in Supabase SQL Editor

-- 1. Teachers table
CREATE TABLE IF NOT EXISTS teachers (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Schedule table
CREATE TABLE IF NOT EXISTS schedule_cells (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  grade TEXT NOT NULL,
  day TEXT NOT NULL,
  committees INTEGER DEFAULT 0,
  subject TEXT DEFAULT '',
  time TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(grade, day)
);

-- 3. Distribution results table
CREATE TABLE IF NOT EXISTS distribution_results (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 4. Enable Row Level Security
ALTER TABLE teachers ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_cells ENABLE ROW LEVEL SECURITY;
ALTER TABLE distribution_results ENABLE ROW LEVEL SECURITY;

-- 5. Allow all operations (no auth needed for this app)
CREATE POLICY "Allow all on teachers" ON teachers FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on schedule_cells" ON schedule_cells FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on distribution_results" ON distribution_results FOR ALL USING (true) WITH CHECK (true);

-- 6. Enable Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE teachers;
ALTER PUBLICATION supabase_realtime ADD TABLE schedule_cells;
ALTER PUBLICATION supabase_realtime ADD TABLE distribution_results;