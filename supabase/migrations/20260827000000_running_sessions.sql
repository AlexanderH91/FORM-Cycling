-- FORM Running session storage.
--
-- Mirrors public.cycling_sessions so the three FORM apps stay recognisably the
-- same shape in one Supabase project, on one login. Purely additive: nothing
-- here touches an existing table.
--
-- Videos never reach this table. The client strips `keyframes` and `track` —
-- both derived from the footage — before inserting, so `report` holds
-- measurements and coaching text only.

create table if not exists public.running_sessions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  created_at        timestamptz not null default now(),
  runner_height_cm  numeric,
  views_captured    text[] not null default '{}',
  cadence_spm       numeric,
  report            jsonb not null default '{}'::jsonb
);

alter table public.running_sessions enable row level security;

-- A runner sees and writes only their own rows. Four explicit policies rather
-- than one permissive `for all`, so a future change to one verb cannot quietly
-- widen the others.
drop policy if exists running_sessions_select_own on public.running_sessions;
create policy running_sessions_select_own on public.running_sessions
  for select using (auth.uid() = user_id);

drop policy if exists running_sessions_insert_own on public.running_sessions;
create policy running_sessions_insert_own on public.running_sessions
  for insert with check (auth.uid() = user_id);

drop policy if exists running_sessions_update_own on public.running_sessions;
create policy running_sessions_update_own on public.running_sessions
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists running_sessions_delete_own on public.running_sessions;
create policy running_sessions_delete_own on public.running_sessions
  for delete using (auth.uid() = user_id);

-- Home, Coach and the progression summary all read "this user's sessions,
-- oldest first"; this is that query.
create index if not exists running_sessions_user_created_idx
  on public.running_sessions (user_id, created_at);
