-- ============================================================
-- TalkSpace database foundation
-- Run this entire file in Supabase SQL Editor.
-- It is safe to re-run because objects use IF NOT EXISTS / drops
-- only for TalkSpace policies and indexes.
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- Profiles
-- ------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  display_name text not null,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Presence
-- ------------------------------------------------------------
create table if not exists public.presence (
  user_id uuid primary key references auth.users(id) on delete cascade,
  is_online boolean not null default false,
  last_seen timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Blocks
-- ------------------------------------------------------------
create table if not exists public.blocks (
  id uuid primary key default gen_random_uuid(),
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint blocks_no_self_block check (blocker_id <> blocked_id),
  constraint blocks_unique_pair unique (blocker_id, blocked_id)
);

-- ------------------------------------------------------------
-- Private conversations
-- ------------------------------------------------------------
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user1_id uuid not null references auth.users(id) on delete cascade,
  user2_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint conversations_no_self check (user1_id <> user2_id)
);

create unique index if not exists conversations_unique_pair
on public.conversations (
  least(user1_id, user2_id),
  greatest(user1_id, user2_id)
);

-- ------------------------------------------------------------
-- Messages
-- ------------------------------------------------------------
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  content text not null check (length(trim(content)) > 0 and length(content) <= 5000),
  created_at timestamptz not null default now()
);

create index if not exists messages_conversation_created_idx
on public.messages (conversation_id, created_at);

-- ------------------------------------------------------------
-- Friend requests / friendships (foundation for the UI)
-- ------------------------------------------------------------
create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users(id) on delete cascade,
  receiver_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','declined','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint friend_requests_no_self check (sender_id <> receiver_id)
);

create unique index if not exists friend_requests_one_active_pair
on public.friend_requests (
  least(sender_id, receiver_id),
  greatest(sender_id, receiver_id)
)
where status = 'pending';

create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  user1_id uuid not null references auth.users(id) on delete cascade,
  user2_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint friendships_no_self check (user1_id <> user2_id)
);

create unique index if not exists friendships_unique_pair
on public.friendships (least(user1_id, user2_id), greatest(user1_id, user2_id));

-- ------------------------------------------------------------
-- Voice-call signalling foundation
-- ------------------------------------------------------------
create table if not exists public.call_signals (
  id uuid primary key default gen_random_uuid(),
  caller_id uuid not null references auth.users(id) on delete cascade,
  receiver_id uuid not null references auth.users(id) on delete cascade,
  signal_type text not null check (signal_type in ('offer','answer','candidate','hangup','reject')),
  signal_data jsonb,
  created_at timestamptz not null default now(),
  constraint call_signals_no_self check (caller_id <> receiver_id)
);

create index if not exists call_signals_receiver_created_idx
on public.call_signals (receiver_id, created_at);

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.presence enable row level security;
alter table public.blocks enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;
alter table public.call_signals enable row level security;

-- Re-running the script should not create duplicate policies.
do $$
declare
  p record;
begin
  for p in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('profiles','presence','blocks','conversations','messages','friend_requests','friendships','call_signals')
  loop
    execute format('drop policy if exists %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end $$;

-- Profiles: authenticated users can discover public profile data.
create policy "profiles_select_authenticated"
on public.profiles for select
to authenticated
using (true);

create policy "profiles_insert_own"
on public.profiles for insert
to authenticated
with check (auth.uid() = id);

create policy "profiles_update_own"
on public.profiles for update
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

-- Presence: anyone authenticated can read status; users modify only themselves.
create policy "presence_select_authenticated"
on public.presence for select
to authenticated
using (true);

create policy "presence_insert_own"
on public.presence for insert
to authenticated
with check (auth.uid() = user_id);

create policy "presence_update_own"
on public.presence for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- Blocks: users can see/manage only blocks involving themselves.
create policy "blocks_select_involved"
on public.blocks for select
to authenticated
using (auth.uid() = blocker_id or auth.uid() = blocked_id);

create policy "blocks_insert_own"
on public.blocks for insert
to authenticated
with check (auth.uid() = blocker_id and blocker_id <> blocked_id);

create policy "blocks_delete_own"
on public.blocks for delete
to authenticated
using (auth.uid() = blocker_id);

-- Conversations: only participants can read/create their own conversations,
-- and creation is blocked when either participant has blocked the other.
create policy "conversations_select_participant"
on public.conversations for select
to authenticated
using (
  auth.uid() = user1_id
  or auth.uid() = user2_id
);

create policy "conversations_insert_participant_unblocked"
on public.conversations for insert
to authenticated
with check (
  (auth.uid() = user1_id or auth.uid() = user2_id)
  and not exists (
    select 1 from public.blocks b
    where (b.blocker_id = user1_id and b.blocked_id = user2_id)
       or (b.blocker_id = user2_id and b.blocked_id = user1_id)
  )
);

-- Messages: only conversation participants may read/write, and blocked pairs
-- cannot read or create messages.
create policy "messages_select_participant_unblocked"
on public.messages for select
to authenticated
using (
  exists (
    select 1
    from public.conversations c
    where c.id = conversation_id
      and (auth.uid() = c.user1_id or auth.uid() = c.user2_id)
      and not exists (
        select 1 from public.blocks b
        where (b.blocker_id = c.user1_id and b.blocked_id = c.user2_id)
           or (b.blocker_id = c.user2_id and b.blocked_id = c.user1_id)
      )
  )
);

create policy "messages_insert_sender_unblocked"
on public.messages for insert
to authenticated
with check (
  auth.uid() = sender_id
  and exists (
    select 1
    from public.conversations c
    where c.id = conversation_id
      and (auth.uid() = c.user1_id or auth.uid() = c.user2_id)
      and not exists (
        select 1 from public.blocks b
        where (b.blocker_id = c.user1_id and b.blocked_id = c.user2_id)
           or (b.blocker_id = c.user2_id and b.blocked_id = c.user1_id)
      )
  )
);

-- Friend requests.
create policy "friend_requests_select_involved"
on public.friend_requests for select
to authenticated
using (auth.uid() = sender_id or auth.uid() = receiver_id);

create policy "friend_requests_insert_sender"
on public.friend_requests for insert
to authenticated
with check (
  auth.uid() = sender_id
  and sender_id <> receiver_id
  and not exists (
    select 1 from public.blocks b
    where (b.blocker_id = sender_id and b.blocked_id = receiver_id)
       or (b.blocker_id = receiver_id and b.blocked_id = sender_id)
  )
);

create policy "friend_requests_update_involved"
on public.friend_requests for update
to authenticated
using (auth.uid() = sender_id or auth.uid() = receiver_id)
with check (auth.uid() = sender_id or auth.uid() = receiver_id);

-- Friendships.
create policy "friendships_select_involved"
on public.friendships for select
to authenticated
using (auth.uid() = user1_id or auth.uid() = user2_id);

create policy "friendships_insert_involved"
on public.friendships for insert
to authenticated
with check (auth.uid() = user1_id or auth.uid() = user2_id);

create policy "friendships_delete_involved"
on public.friendships for delete
to authenticated
using (auth.uid() = user1_id or auth.uid() = user2_id);

-- Call signalling: only caller/receiver can access signals.
create policy "call_signals_select_participant"
on public.call_signals for select
to authenticated
using (auth.uid() = caller_id or auth.uid() = receiver_id);

create policy "call_signals_insert_participant_unblocked"
on public.call_signals for insert
to authenticated
with check (
  auth.uid() = caller_id
  and not exists (
    select 1 from public.blocks b
    where (b.blocker_id = caller_id and b.blocked_id = receiver_id)
       or (b.blocker_id = receiver_id and b.blocked_id = caller_id)
  )
);

create policy "call_signals_delete_participant"
on public.call_signals for delete
to authenticated
using (auth.uid() = caller_id or auth.uid() = receiver_id);

-- ------------------------------------------------------------
-- Realtime publication
-- ------------------------------------------------------------
-- These statements are intentionally guarded because a table may already be
-- in the publication on an existing project.
do $$
begin
  begin alter publication supabase_realtime add table public.messages; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.presence; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.call_signals; exception when duplicate_object then null; end;
end $$;
