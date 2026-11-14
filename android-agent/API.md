# Android Visible UI API

This is the authenticated task-planning and visible-action queue for the Worker-owned Android companion app. It is brand-independent and does not use device registration.

## Setup

1. Apply the Android task migrations in `supabase/migrations/` in timestamp order.
2. Keep `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` configured only on the server.
3. The configured Worker AI provider generates a structured plan. The server validates every action before approval.

Without Supabase persistence, Android task endpoints return HTTP 503.

## Lifecycle

- `POST /api/android/tasks` with `{ "instruction": "..." }` creates a task and asks the configured AI model for a typed plan.
- `GET /api/android/tasks/:id` fetches plan and progress.
- `POST /api/android/tasks/:id/approve` with the exact `{ "planHash": "..." }` approves that plan for ten minutes.
- `GET /api/android/tasks/:id/next-action` returns one action at a time and redelivers an in-flight action until acknowledged.
- `POST /api/android/tasks/:id/action-result` acknowledges the dispatched action.
- `POST /api/android/tasks/:id/reject`, `/pause`, and `/cancel` control the task.
- `GET /api/android/tasks` and `GET /api/android/tasks/:id` show task and action history.

All responses are marked `Cache-Control: no-store`. Unknown actions, invalid package names, blocked system apps, sensitive typed text, oversized plans, stale approvals, and duplicate acknowledgements are rejected.

## Supported action vocabulary

- `launch_app`: launch a normal installed app with a launcher activity. The phone sends only the names/package IDs of apps explicitly named in the command (up to five matches), and checks locally that the app is installed before launching.
- `find_visible_text` / `tap_visible_node`: find an exact, unique visible label in the currently approved app.
- `type_text`: enter ordinary non-sensitive text (maximum 200 characters) into a focused visible editable field.
- `press_enter`: submit a focused visible field only when the plan is a user-requested search/query. Android 10 may not expose the required IME action; in that case the step is blocked rather than simulated.
- `press_back`: navigate back within the approved active app.\n- `scroll_forward` / `scroll_backward`: scroll one page in the unique visible scrollable area of the approved app.
- `wait_for_ui`: bounded to 250–10,000 ms.
- `report_state`: report whether the approved app is currently active without storing a screen dump.

Each UI action is bound to the package selected by the preceding `launch_app` step. The service only acts while an approved task is active and the current visible window matches that package. The user must enable Android Accessibility explicitly.

## Safety boundary

The planner and validator block credential entry, payments, purchases, sending messages, publishing, deleting, sharing, transfers, account/security changes, permission grants, hidden control, browser automation, and arbitrary shell/code. Taps on labels that indicate consequential actions are blocked. Plans require review and approval, and approval expires after ten minutes. UI exposure varies by app and Android version; an app that hides controls from Accessibility may not be automatable.

The Android module targets Android 10 (API 29) and later, without OEM-specific setup flows. Actual compatibility still depends on the app's UI, Android version, and vendor implementation. Device registration, browser automation, PC bridge, and voice commands remain out of scope for this increment.

## Validation status

CI and APK build must pass before this change is considered build-verified. Physical-device end-to-end testing is still required across representative Android versions and manufacturers.
