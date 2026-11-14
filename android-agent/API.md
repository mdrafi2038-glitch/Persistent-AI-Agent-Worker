# Android Visible UI API (foundation)

This is the server-side approval and action-queue foundation for the Worker-owned Android app in this repository. Every route uses the existing signed-in Worker session cookie. No device-registration workflow is used.

## Setup

1. Apply \`supabase/migrations/20261114000000_android_agent.sql\` in the Supabase SQL Editor.
2. Keep \`SUPABASE_URL\` and \`SUPABASE_SERVICE_ROLE_KEY\` configured only on the Render server.
3. The existing Worker AI provider is used to generate a structured plan. The plan is validated against the allowlist before it can be approved.

If Supabase is not configured, Android task endpoints return HTTP 503 rather than using volatile in-memory storage.

## Lifecycle

- \`POST /api/android/tasks\` with \`{ "instruction": "..." }\` creates a task and asks the configured AI model for a typed plan.
- \`GET /api/android/tasks/:id\` fetches plan and progress.
- \`POST /api/android/tasks/:id/approve\` with the exact \`{ "planHash": "..." }\` approves that plan for ten minutes.
- \`GET /api/android/tasks/:id/next-action\` returns one action at a time. It redelivers the current in-flight action until acknowledged; the Android client must deduplicate by action ID. A later step is never dispatched while an earlier step is awaiting acknowledgement.
- \`POST /api/android/tasks/:id/action-result\` with \`{ "actionId": "...", "status": "completed|failed|blocked", "result": "..." }\` acknowledges the dispatched action.
- \`POST /api/android/tasks/:id/reject\`, \`/pause\`, and \`/cancel\` stop the task.
- \`GET /api/android/tasks\` and \`GET /api/android/tasks/:id\` show task and action history.

All responses are marked \`Cache-Control: no-store\`. Unknown actions, arbitrary shell commands, unapproved apps, sensitive typed text, oversized plans, stale approvals, and duplicate acknowledgements are rejected.

## Initial allowlist

- \`launch_app\`: YouTube only (\`com.google.android.youtube\`).
- \`find_visible_text\` / \`tap_visible_node\`: exact visible text selector.
- \`type_text\`: ordinary non-sensitive text, maximum 200 characters.
- \`press_back\`.
- \`wait_for_ui\`: bounded to 250–10,000 ms.
- \`report_state\`.

The API does not accept arbitrary gestures, code, shell commands, passwords, PINs, OTPs, payments, purchases, posts, or message sending. The Worker-owned Android app includes a plan-review dialog, a recent task history screen, pause/resume/cancel controls, and an Accessibility service that is inactive until the user enables it and approves a task. The service is restricted to visible YouTube UI; typing and search submission require a focused visible field. Pause is accepted only between acknowledged steps.

## Current implementation boundary

The server API, applied SQL migration, AI plan generation, typed-plan validation, Android plan-review dialog, and initial visible-UI Accessibility service are included. The phone app still needs a richer task-history/progress screen, resume UX, and end-to-end testing on a physical device. Current launch allowlist is YouTube only; no result is auto-played.
