-- Phase 1 — Subcontractor payments. Run once in the Supabase SQL editor for the
-- AGT project (otgpzpepmurbydcghygb). Safe to re-run.
--
-- subcontractors  — maps a sub to its QBO vendor + contact for sending the form.
-- sub_takeoffs    — one billing submission per completed job: the pre-filled
--                   labor lines, the sub's confirm/override/photos, and the
--                   resulting QBO Bill. Admin reads via RLS; all writes (incl.
--                   the public token form) go through service-role API endpoints.

create table if not exists subcontractors (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  qbo_vendor_id  text,                 -- QBO Vendor.Id the bill is raised against
  qbo_vendor_name text,
  email          text,                 -- where the takeoff form link is sent
  phone          text,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists sub_takeoffs (
  id                uuid primary key default gen_random_uuid(),
  token             text unique not null,          -- public form URL key
  status            text not null default 'sent',  -- sent|submitted|approved|rejected|billed
  job_id            text,                           -- Jobber job encoded id
  job_number        integer,
  client_name       text,
  project_qbo_id    text,                           -- QBO project (sub-customer) for the bill
  arcsite_drawing_id text,
  subcontractor_id  uuid references subcontractors(id),
  line_items        jsonb not null default '[]',    -- [{name,arcsite_product_id,qty,unit,agreed_cost,line_total,confirmed,override_cost,override_comment,override_image_url}]
  completion_photos jsonb not null default '[]',    -- [{url}]
  total_amount      numeric,
  notes             text,
  submitted_at      timestamptz,
  reviewed_at       timestamptz,
  reviewed_by       text,
  qbo_bill_id       text,
  qbo_bill_doc      text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists sub_takeoffs_status_idx on sub_takeoffs (status, created_at desc);
create index if not exists sub_takeoffs_token_idx on sub_takeoffs (token);

alter table subcontractors enable row level security;
alter table sub_takeoffs enable row level security;

drop policy if exists subcontractors_read on subcontractors;
create policy subcontractors_read on subcontractors for select to authenticated using (true);

drop policy if exists sub_takeoffs_read on sub_takeoffs;
create policy sub_takeoffs_read on sub_takeoffs for select to authenticated using (true);
