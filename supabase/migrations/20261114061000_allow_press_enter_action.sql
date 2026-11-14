-- Allow the on-screen search submit action in the typed action allowlist.
alter table public.android_agent_actions drop constraint if exists android_agent_actions_action_type_check;
alter table public.android_agent_actions add constraint android_agent_actions_action_type_check check (action_type = any (array['launch_app','find_visible_text','tap_visible_node','type_text','press_back','press_enter','wait_for_ui','report_state']::text[]));
