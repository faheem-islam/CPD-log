-- CPD Logger: initial schema (Postgres 15, Supabase).
--
-- Where this runs: create the Supabase project in the London region (eu-west-2) so the data stays in the UK.
--
-- What is stored: a person's own CPD log entries, their settings, a monthly count of AI calls, and (optionally)
-- organisation membership. It stores NO API keys, NO page text copied from other sites and NO transcripts.
-- Entry text is only what the person typed or confirmed.
--
-- How access works:
--   * Row-level security is ENABLED and FORCED on every table. FORCE means even the table owner is subject
--     to the policies unless it has BYPASSRLS. On Supabase the `postgres` role normally has BYPASSRLS (check with
--     select rolbypassrls from pg_roles where rolname = 'postgres') and `service_role` bypasses RLS, so the
--     dashboard and server-side admin work still function. The two helper functions below rely on that: they run as the function owner (SECURITY DEFINER) and must be able to read
--     org_members and cpd_entries. If the owner role did not have BYPASSRLS they would only see the caller's own
--     rows, so org_member_summary() would return less, never more (it fails closed, it does not leak).
--   * Users only ever reach their own cpd_entries and user_settings rows.
--   * Organisation admins can read their member roster and a yearly hours total per member through
--     org_member_summary(). They can never read cpd_entries rows, titles, notes or any text.
--   * ai_usage cannot be written directly by anyone using the API. Only increment_ai_usage() changes it.
--   * Every function the app can call is SECURITY DEFINER with an empty search_path, uses fully qualified names,
--     takes the user from auth.uid() (never from a parameter) and is executable by signed-in users only.

begin;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table public.organisations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 200),
  created_at timestamptz not null default now()
);
comment on table public.organisations is 'A team or employer. Created by the project owner (SQL editor or service role), not by app users.';

create table public.org_members (
  org_id     uuid not null references public.organisations (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       text not null default 'member' check (role in ('admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index org_members_user_idx on public.org_members (user_id);
comment on table public.org_members is 'Who belongs to which organisation, and who administers it. Written by the project owner, not by app users.';

create table public.user_settings (
  user_id          uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  name             text not null default '',
  job_role         text not null default '',
  responsibilities text not null default '',
  sector           text not null default '',
  active_profiles  text[] not null default '{ice}',
  custom_fields    jsonb not null default '[]'::jsonb,
  updated_at       timestamptz not null default now(),
  constraint user_settings_profiles_check check (cardinality(active_profiles) >= 1 and active_profiles <@ array['ice', 'istructe', 'custom']),
  constraint user_settings_custom_fields_check check (jsonb_typeof(custom_fields) = 'array')
);
comment on table public.user_settings is 'One row per person: the details printed at the top of exports, and which profiles are switched on.';

create table public.cpd_entries (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  profile                   text not null check (profile in ('ice', 'istructe', 'custom')),
  title                     text not null,
  url                       text,
  provider                  text,
  source_type               text not null check (source_type in ('video', 'article', 'webinar', 'document', 'live_event', 'other')),
  published_at              date,
  date_completed            date not null,
  date_end                  date,
  detected_duration_minutes numeric check (detected_duration_minutes is null or detected_duration_minutes >= 0),
  hours                     numeric(6, 2) not null check (hours >= 0),
  hours_confirmed           boolean not null,
  theme                     text,
  category                  text,
  structural_safety         boolean,
  sustainability            boolean,
  dev_plan_ref              text not null default 'unplanned',
  learning_points           text not null default '',
  benefits                  jsonb not null default '{"helped": "", "future": "", "nextYear": ""}'::jsonb,
  development_gained        text not null default '',
  custom                    jsonb not null default '{}'::jsonb,
  notes                     text not null default '',
  ai_assisted               boolean not null default false,
  confidence                jsonb not null default '{}'::jsonb,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  deleted_at                timestamptz,
  constraint cpd_entries_dates_check check (date_end is null or date_end >= date_completed),
  constraint cpd_entries_benefits_check check (jsonb_typeof(benefits) = 'object'),
  constraint cpd_entries_custom_check check (jsonb_typeof(custom) = 'object'),
  constraint cpd_entries_confidence_check check (jsonb_typeof(confidence) = 'object')
);
comment on table public.cpd_entries is 'A person''s CPD log entries. Deleting sets deleted_at (soft delete) so it can be undone.';
comment on column public.cpd_entries.hours is 'The person''s own effective learning time in hours. Never filled in automatically without the person confirming it.';
comment on column public.cpd_entries.confidence is 'Per-field badge (high, low, estimate, missing) and the plain-language evidence shown to the person. Not page text.';

-- Newest first for the log view, and a small index for "my live entries".
create index cpd_entries_user_date_idx on public.cpd_entries (user_id, date_completed desc);
create index cpd_entries_user_live_idx on public.cpd_entries (user_id) where deleted_at is null;

create table public.ai_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  month   text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  calls   integer not null default 0 check (calls >= 0),
  primary key (user_id, month)
);
comment on table public.ai_usage is 'How many AI calls a person has made in a month (YYYY-MM, UK calendar month). A count only: no prompts, no answers.';

-- ---------------------------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------------------------

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

create trigger cpd_entries_set_updated_at
  before update on public.cpd_entries
  for each row execute function public.set_updated_at();

create trigger user_settings_set_updated_at
  before update on public.user_settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Table privileges. Row-level security decides which rows; these decide which kinds of access exist at all.
-- Supabase grants broad default privileges, so take them away from anon and PUBLIC and give back only what is needed.
-- ---------------------------------------------------------------------------------------------

revoke all on table public.organisations, public.org_members, public.user_settings, public.cpd_entries, public.ai_usage from public, anon;
revoke all on table public.organisations, public.org_members, public.user_settings, public.cpd_entries, public.ai_usage from authenticated;

grant select, insert, update, delete on table public.cpd_entries, public.user_settings to authenticated;
grant select on table public.organisations, public.org_members, public.ai_usage to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------------------------

alter table public.organisations enable row level security;
alter table public.organisations force row level security;
alter table public.org_members   enable row level security;
alter table public.org_members   force row level security;
alter table public.user_settings enable row level security;
alter table public.user_settings force row level security;
alter table public.cpd_entries   enable row level security;
alter table public.cpd_entries   force row level security;
alter table public.ai_usage      enable row level security;
alter table public.ai_usage      force row level security;

-- Helper for the org_members policy. A policy on org_members that read org_members would recurse forever,
-- so the admin check is a SECURITY DEFINER function (it reads the table as its owner, see the note at the top).
create function public.is_org_admin(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.org_members m
    where m.org_id = p_org
      and m.user_id = auth.uid()
      and m.role = 'admin'
  );
$$;

-- cpd_entries: a person reads, adds, changes and deletes only their own rows.
-- The WITH CHECK clauses stop a row being inserted for someone else, or an update moving a row to someone else.
-- There is deliberately NO policy for organisation admins: they never see entries.
create policy cpd_entries_select_own on public.cpd_entries
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy cpd_entries_insert_own on public.cpd_entries
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy cpd_entries_update_own on public.cpd_entries
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy cpd_entries_delete_own on public.cpd_entries
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- user_settings: same rules, one row per person.
create policy user_settings_select_own on public.user_settings
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy user_settings_insert_own on public.user_settings
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy user_settings_update_own on public.user_settings
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy user_settings_delete_own on public.user_settings
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- ai_usage: a person can read their own counts. There is NO insert, update or delete policy and no table
-- privilege for them, so the only way to change a count is increment_ai_usage() below.
create policy ai_usage_select_own on public.ai_usage
  for select to authenticated
  using (user_id = (select auth.uid()));

-- organisations: visible to their members (any role). No write policies: the project owner manages these.
create policy organisations_select_member on public.organisations
  for select to authenticated
  using (exists (
    select 1 from public.org_members m
    where m.org_id = organisations.id and m.user_id = (select auth.uid())
  ));

-- org_members: a person sees their own memberships, and an organisation admin sees the roster of that organisation.
-- No write policies: the project owner manages membership.
create policy org_members_select_own_or_admin on public.org_members
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_org_admin(org_id));

-- ---------------------------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------------------------

-- Add one AI call for the signed-in user in the given month, but only while they are under the cap.
-- The check and the increment are one INSERT ... ON CONFLICT DO UPDATE ... WHERE statement, so two calls at the
-- same moment cannot both pass the check: the second waits for the row lock, then sees the new count.
-- p_cap <= 0 (or null) means no calls are allowed and nothing is counted.
-- p_month must be the current UK month or the one before or after it, so the table cannot be filled with rows for
-- months that will never matter.
-- The cap is chosen by the server. A person calling this directly with a larger cap can only use up their own
-- count faster; counts only ever go up, so they cannot lower it to get around the server's cap.
create function public.increment_ai_usage(p_month text, p_cap integer)
returns table (allowed boolean, used integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_used integer;
  v_this timestamp := pg_catalog.date_trunc('month', pg_catalog.now() at time zone 'Europe/London');
begin
  if v_user is null then
    raise exception 'You are not signed in.' using errcode = '28000';
  end if;
  if p_month is null or p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'The month must be written as YYYY-MM.' using errcode = '22023';
  end if;
  -- Only this UK month and the ones either side of it (so the server and the database can disagree about the date
  -- around midnight on the 1st). Without this a signed-in user could call the function in a loop for every month from
  -- 0000-01 to 9999-12 and add a row to ai_usage each time, without limit.
  if p_month not in (
    pg_catalog.to_char(v_this - interval '1 month', 'YYYY-MM'),
    pg_catalog.to_char(v_this, 'YYYY-MM'),
    pg_catalog.to_char(v_this + interval '1 month', 'YYYY-MM')
  ) then
    raise exception 'The month is outside the range that can be counted.' using errcode = '22023';
  end if;

  if p_cap is null or p_cap <= 0 then
    select coalesce((select u.calls from public.ai_usage u where u.user_id = v_user and u.month = p_month), 0) into v_used;
    return query select false, v_used;
    return;
  end if;

  insert into public.ai_usage as u (user_id, month, calls)
  values (v_user, p_month, 1)
  on conflict (user_id, month) do update
    set calls = u.calls + 1
    where u.calls < p_cap
  returning u.calls into v_used;

  if found then
    return query select true, v_used;
    return;
  end if;

  -- The row exists and was already at the cap, so the update did not run.
  select coalesce((select u.calls from public.ai_usage u where u.user_id = v_user and u.month = p_month), 0) into v_used;
  return query select false, v_used;
end;
$$;

-- How many AI calls the signed-in user has used in a month. Read only.
create function public.get_ai_usage(p_month text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select u.calls from public.ai_usage u where u.user_id = auth.uid() and u.month = p_month),
    0
  );
$$;

-- Yearly totals per member for an organisation, for administrators only. Returns no rows unless the
-- signed-in user is an admin of p_org. Soft-deleted entries are left out. Only counts and hours come back:
-- no titles, links, notes or any text. The year is the calendar year of date_completed.
create function public.org_member_summary(p_org uuid)
returns table (user_id uuid, year integer, hours numeric, entry_count integer)
language sql
stable
security definer
set search_path = ''
as $$
  select
    e.user_id,
    pg_catalog.date_part('year', e.date_completed)::integer as year,
    pg_catalog.sum(e.hours) as hours,
    pg_catalog.count(*)::integer as entry_count
  from public.org_members m
  join public.cpd_entries e on e.user_id = m.user_id
  where m.org_id = p_org
    and e.deleted_at is null
    and public.is_org_admin(p_org)
  group by e.user_id, pg_catalog.date_part('year', e.date_completed)
  order by pg_catalog.date_part('year', e.date_completed) desc, e.user_id;
$$;

-- Only signed-in users can call these. Supabase grants EXECUTE to anon by default, so take it away explicitly.
revoke execute on function public.set_updated_at()                   from public, anon, authenticated;
revoke execute on function public.is_org_admin(uuid)                 from public, anon;
revoke execute on function public.increment_ai_usage(text, integer)  from public, anon;
revoke execute on function public.get_ai_usage(text)                 from public, anon;
revoke execute on function public.org_member_summary(uuid)           from public, anon;

grant execute on function public.is_org_admin(uuid)                  to authenticated;
grant execute on function public.increment_ai_usage(text, integer)   to authenticated;
grant execute on function public.get_ai_usage(text)                  to authenticated;
grant execute on function public.org_member_summary(uuid)            to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Comments stored in the database, so the reasons are visible in the dashboard and in \d+ output
-- ---------------------------------------------------------------------------------------------

comment on policy cpd_entries_select_own on public.cpd_entries is 'A person can read only their own entries. Organisation admins have no policy here, so they can never read entries.';
comment on policy cpd_entries_insert_own on public.cpd_entries is 'A person can add entries only for themselves: WITH CHECK stops a forged user_id.';
comment on policy cpd_entries_update_own on public.cpd_entries is 'A person can change only their own entries, and cannot move one to another user (WITH CHECK).';
comment on policy cpd_entries_delete_own on public.cpd_entries is 'A person can hard delete only their own entries (used by "Delete my data"). Normal deletes are soft: deleted_at is set.';
comment on policy user_settings_select_own on public.user_settings is 'A person can read only their own settings.';
comment on policy user_settings_insert_own on public.user_settings is 'A person can create only their own settings row.';
comment on policy user_settings_update_own on public.user_settings is 'A person can change only their own settings row, and cannot reassign it.';
comment on policy user_settings_delete_own on public.user_settings is 'A person can delete only their own settings row.';
comment on policy ai_usage_select_own on public.ai_usage is 'A person can read their own AI call counts. There is no write policy: counts change only through increment_ai_usage().';
comment on policy organisations_select_member on public.organisations is 'An organisation is visible to its members (any role).';
comment on policy org_members_select_own_or_admin on public.org_members is 'A person sees their own memberships; an organisation admin also sees that organisation''s roster.';

comment on function public.is_org_admin(uuid) is 'True when the signed-in user is an admin of the organisation. SECURITY DEFINER so the org_members policy can use it without recursing.';
comment on function public.increment_ai_usage(text, integer) is 'Adds one AI call for the signed-in user in a month, atomically, only while under the cap. The only way ai_usage changes.';
comment on function public.get_ai_usage(text) is 'AI calls the signed-in user has used in a month (0 if none).';
comment on function public.org_member_summary(uuid) is 'Yearly hours and entry counts per member, for organisation admins only. Never returns titles, links, notes or other text.';

commit;
