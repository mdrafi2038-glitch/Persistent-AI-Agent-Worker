-- Add persistent retry metadata for the autonomous task queue.
alter table public.agent_tasks
  add column if not exists attempt_count integer not null default 0,
  add column if not exists max_attempts integer not null default 3,
  add column if not exists last_error text;

update public.agent_tasks
set attempt_count = 0, max_attempts = 3
where attempt_count is null or max_attempts is null;
