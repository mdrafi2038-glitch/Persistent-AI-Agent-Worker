-- Run this entire file in Supabase SQL Editor.
-- The application accesses these tables from the server only.

create table if not exists public.chat_sessions (
  id uuid primary key,
  title text not null default 'New chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.chat_messages (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_session_created_idx
  on public.chat_messages(session_id, created_at);

-- Explicit, user-controlled long-term notes for the agent.
create table if not exists public.agent_memories (
  id uuid primary key default gen_random_uuid(),
  category text not null default 'general',
  content text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agent_memories_updated_idx
  on public.agent_memories(updated_at desc);

-- Persistent task tracking/queue. This stores tasks; execution is a separate worker feature.
create table if not exists public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  result text,
  scheduled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agent_tasks_status_created_idx
  on public.agent_tasks(status, created_at);

-- Access is server-only. The service-role key must never be exposed in browser code.
alter table public.chat_sessions enable row level security;
alter table public.chat_messages enable row level security;
alter table public.agent_memories enable row level security;
alter table public.agent_tasks enable row level security;
