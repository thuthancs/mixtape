-- Run this in the Supabase SQL Editor (supabase.com dashboard)
-- to create the comments table for the song comments feature.

create table comments (
  id uuid primary key default gen_random_uuid(),
  clip_id text not null,
  content text not null,
  author_name text default 'Anonymous',
  created_at timestamptz default now()
);

create index comments_clip_id_idx on comments(clip_id);

alter table comments enable row level security;
create policy "Allow read" on comments for select using (true);
create policy "Allow insert" on comments for insert with check (true);
