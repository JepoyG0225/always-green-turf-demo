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

-- ── Row Level Security (dispatch_logs only) ─────────────────────────
-- dispatch_logs holds lead PII (name, email, address, raw payload), so we do
-- NOT allow the public anon key to read it. The engine writes with the anon
-- key (INSERT), and the /dispatch admin reads it only when signed in
-- (authenticated SELECT). We intentionally do NOT touch RLS on
-- sales_rep_data / dispatch_memory here — changing it would break the anon
-- reads/writes those tables already rely on.
alter table dispatch_logs enable row level security;

drop policy if exists log_insert on dispatch_logs;
create policy log_insert on dispatch_logs for insert to anon, authenticated with check (true);

drop policy if exists log_read on dispatch_logs;
create policy log_read on dispatch_logs for select to authenticated using (true);
