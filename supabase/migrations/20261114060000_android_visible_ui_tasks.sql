-- Android visible-UI assistant state. Server-only access via Supabase service role.
create table if not exists public.android_agent_tasks (
  id uuid primary key default gen_random_uuid(),
  instruction text not null check (char_length(instruction) between 1 and 4000),
  status text not null default 'planning'
    check (status in ('planning','pending_approval','approved','paused','rejected','approval_expired','blocked','failed','completed','cancelled')),
  plan jsonb,
  plan_hash text,
  approved_at timestamptz,
  approval_expires_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (plan_hash is null or plan_hash ~ '^[a-f0-9]{64}$')
);

create index if not exists android_agent_tasks_status_created_idx
  on public.android_agent_tasks(status, created_at desc);

create table if not exists public.android_agent_actions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.android_agent_tasks(id) on delete cascade,
  step_index integer not null check (step_index between 0 and 19),
  action_type text not null check (action_type in ('launch_app','find_visible_text','tap_visible_node','type_text','press_back','press_enter','wait_for_ui','report_state')),
  payload jsonb not null,
  status text not null default 'queued'
    check (status in ('queued','dispatched','completed','failed','blocked','cancelled')),
  result text,
  dispatched_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(task_id, step_index)
);

create index if not exists android_agent_actions_queue_idx
  on public.android_agent_actions(task_id, status, step_index);

alter table public.android_agent_tasks enable row level security;
alter table public.android_agent_actions enable row level security;

-- No anon/authenticated policies or grants: all access stays server-side.
