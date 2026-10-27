-- Run this in Supabase SQL Editor.
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

-- Access is server-only. The app uses the service-role key on the server,
-- never in the browser. Do not expose the service-role key as a NEXT_PUBLIC variable.
alter table public.chat_sessions enable row level security;
alter table public.chat_messages enable row level security;
