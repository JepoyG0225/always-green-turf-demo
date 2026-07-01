-- DispatchAI schema — run in the Supabase SQL editor for the project that holds
-- sales_rep_data / dispatch_memory (the same project you put in dispatch/config.js).
-- Safe to re-run.

-- Cache geocodes + an active flag on reps.
alter table if exists sales_rep_data
  add column if not exists lat double precision,
  add column if not exists lng double precision,
  add column if not exists active boolean default true;

-- Memory of which rep an address was dispatched to.
alter table if exists dispatch_memory
  add column if not exists calendar_id text,
  add column if not exists rep_address text,
  add column if not exists dispatch_count integer default 1,
  add column if not exists last_dispatched_at timestamptz;

-- One row per dispatch execution.
create table if not exists dispatch_logs (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  status            text not null,
  contact_id        text,
  lead_name         text,
  lead_email        text,
  lead_address      text,
  address_key       text,
  preferred_days    text,
  time_window       text,
  memory_hit        boolean default false,
  chosen_rep_id     text,
  chosen_rep_name   text,
  drive_minutes     numeric,
  appointment_id    text,
  appointment_start timestamptz,
  ghl_assigned_id   text,
  remarks           text,
  error             text,
  duration_ms       integer,
  steps             jsonb,
  raw_payload       jsonb
);
create index if not exists dispatch_logs_created_at_idx on dispatch_logs (created_at desc);

-- ── Row Level Security ──────────────────────────────────────────────
-- The /dispatch admin pages read these tables from the browser with the anon
-- key + a signed-in session (same model as the time-off app). Allow any
-- authenticated user to read/write. The serverless /api/dispatch function uses
-- the service-role key and bypasses RLS.
alter table dispatch_logs    enable row level security;
alter table sales_rep_data   enable row level security;
alter table dispatch_memory  enable row level security;

drop policy if exists auth_all on dispatch_logs;
create policy auth_all on dispatch_logs   for all to authenticated using (true) with check (true);
drop policy if exists auth_all on sales_rep_data;
create policy auth_all on sales_rep_data  for all to authenticated using (true) with check (true);
drop policy if exists auth_all on dispatch_memory;
create policy auth_all on dispatch_memory for all to authenticated using (true) with check (true);
