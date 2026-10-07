-- looot-tables schema. Single-user model: any signed-in user can read and write.
-- Turn off public sign-ups in Supabase (Authentication, Providers, Email) and
-- create your own user, so "authenticated" means "you".

create table public.tables (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.columns (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.tables(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('input', 'enrichment')),
  operation_id text,
  -- { "<operation input name>": "text with {{Column Name}} placeholders" }
  input_map jsonb,
  -- optional dot path picked out of the run result, e.g. "email" or "data.0.email"
  output_path text,
  -- price per call in USD at the time the column was created
  unit_cost_usd numeric,
  position integer not null default 0,
  unique (table_id, name)
);

create table public.rows (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.tables(id) on delete cascade,
  position integer not null default 0
);

create table public.cells (
  row_id uuid not null references public.rows(id) on delete cascade,
  column_id uuid not null references public.columns(id) on delete cascade,
  value jsonb,
  status text not null default 'empty' check (status in ('empty', 'pending', 'done', 'error')),
  cost_usd numeric not null default 0,
  run_id text,
  error text,
  primary key (row_id, column_id)
);

create index columns_table_id_idx on public.columns (table_id, position);
create index rows_table_id_idx on public.rows (table_id, position);
create index cells_column_id_idx on public.cells (column_id);

alter table public.tables enable row level security;
alter table public.columns enable row level security;
alter table public.rows enable row level security;
alter table public.cells enable row level security;

create policy "signed in users manage tables" on public.tables
  for all to authenticated using (true) with check (true);
create policy "signed in users manage columns" on public.columns
  for all to authenticated using (true) with check (true);
create policy "signed in users manage rows" on public.rows
  for all to authenticated using (true) with check (true);
create policy "signed in users manage cells" on public.cells
  for all to authenticated using (true) with check (true);
