-- Run once in Supabase Dashboard > SQL Editor.
-- The browser app uses a publishable key plus Supabase Auth and these RLS policies.

create table if not exists public.vocab_progress (
    user_id uuid primary key references auth.users(id) on delete cascade,
    state jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now()
);

alter table public.vocab_progress enable row level security;

grant select, insert, update on public.vocab_progress to authenticated;

drop policy if exists "Users can read their own progress" on public.vocab_progress;
create policy "Users can read their own progress"
on public.vocab_progress
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own progress" on public.vocab_progress;
create policy "Users can insert their own progress"
on public.vocab_progress
for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own progress" on public.vocab_progress;
create policy "Users can update their own progress"
on public.vocab_progress
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
