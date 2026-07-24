-- Labor rate card (agreed subcontractor labor costs) — run once in the Supabase
-- SQL editor for the AGT project (otgpzpepmurbydcghygb). Safe to re-run.
--
-- Reference data managed from /admin/labor-rates. Reads are allowed for any
-- signed-in admin; all writes go through /api/labor-rates using the service-role
-- key (which bypasses RLS), so no anon/authenticated write policy is needed.

create table if not exists labor_rates (
  id                 uuid primary key default gen_random_uuid(),
  category           text,
  item               text not null,
  description        text,
  unit               text,
  cost               numeric not null default 0,   -- agreed labor cost per unit
  notes              text,
  arcsite_product_id text,                          -- join key to the ArcSite takeoff line
  active             boolean not null default true,
  sort_order         integer,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists labor_rates_category_idx on labor_rates (category);
create index if not exists labor_rates_arcsite_idx on labor_rates (arcsite_product_id);

alter table labor_rates enable row level security;

drop policy if exists labor_rates_read on labor_rates;
create policy labor_rates_read on labor_rates for select to authenticated using (true);
