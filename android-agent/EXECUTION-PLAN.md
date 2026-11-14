# Android Visible UI Assistance — Implementation Plan

This document defines the next Android execution increment for the Persistent AI Agent Worker. It is a new Worker-owned Android companion module; it must not reuse, import, edit, or depend on any files from the separate Private/Privateagent/Updatedagent projects.

## Product goal

A user can type a natural-language instruction in Bangla, Banglish, or English (for example, "YouTube open kore ekta gan search koro"). The Worker turns it into a short, inspectable plan. The Android companion app can then carry out permitted steps through visible, on-device UI interaction, including Android Accessibility Service where the user explicitly enables it.

This is visible UI assistance, not hidden remote control. The app must show what it is about to do, what it is doing, and what happened.

## Explicit scope

Included in this increment:
- Natural-language request -> structured plan -> ordered action steps.
- On-device app launch and visible UI interaction through Android Accessibility.
- Live execution status, step-by-step progress, pause, cancel, retry where safe, and an execution history.
- Approval prompts before meaningful actions and again when the plan changes materially.
- Server-side task/approval records and an authenticated API contract.
- Bangla/Banglish/English command text.

Explicitly excluded:
- Device registration/pairing workflow (not required by the user).
- Browser automation.
- PC bridge.
- Voice commands for now.
- Hidden/background interaction, arbitrary shell commands, arbitrary code execution, or bypassing app/OS security.
- Any dependency on the separate Personal Agent Android applications.

## Execution lifecycle

1. **Request received** — store the user's exact instruction and conversation/task reference.
2. **Plan generated** — AI emits a validated JSON plan with a bounded list of typed actions, target app/package where applicable, human-readable explanation, and risk class.
3. **Plan preview** — show all steps to the user in the Worker UI and on the phone.
4. **Approval** — user approves the plan. High-impact steps require a fresh, step-specific confirmation at execution time.
5. **Visible execution** — Android app executes one step at a time using documented Android intents and Accessibility node actions/gestures only where necessary. Keep the screen visible and expose progress.
6. **Verification** — inspect the visible UI state after each step; do not report success without evidence.
7. **Completion** — persist per-step result, timestamps, and a concise summary. If blocked, stop and explain the blocker.

## Initial action vocabulary

Allowlist typed actions rather than accepting arbitrary instructions from the model:
- `launch_app`: open an installed app using its package/launch intent.
- `find_visible_text`: locate text currently exposed in the active accessibility tree.
- `tap_visible_node`: tap a uniquely identified visible node after validating its current screen context.
- `type_text`: enter ordinary user-provided search/query text into a focused field.
- `press_back`: navigate back one screen.
- `wait_for_ui`: wait for a bounded UI condition with a strict timeout.
- `report_state`: return a sanitized summary of the visible screen and current step.

Each action must have a strict schema, bounded input length, timeout, and allowed-app/context checks. No generic "execute", shell, JavaScript, file-system, or arbitrary gesture action is permitted.

## Approval and safety rules

- The user must explicitly enable Android Accessibility Service in Android Settings. Explain why it is needed and how to disable it.
- Approval is required before starting an execution plan. Require a new confirmation for any newly introduced step, unexpected destination, or materially changed plan.
- Require explicit per-step confirmation for sending messages, publishing/posting, purchases, payments, deleting data, changing account/security settings, granting permissions, or other externally consequential/irreversible actions. These categories should initially be blocked rather than automated.
- Never request, read, store, type, or transmit passwords, PINs, OTPs, recovery codes, or payment credentials.
- Never bypass login, CAPTCHA, paywalls, permission dialogs, or app security controls.
- Do not interact with hidden/off-screen UI or claim an action occurred when the visible UI cannot verify it.
- Stop on ambiguous targets, unexpected dialogs, app changes outside the approved plan, or loss of user approval.
- Provide pause and cancel controls that are honored between every action.
- Keep an auditable history, but redact sensitive screen text and never store full accessibility dumps by default.

## Android implementation boundary

Extend the existing Worker-owned native Android app under `android-agent/app/`. This app lives in this repository and is separate from the user's other Personal Agent repositories. Keep its existing chat, reminder, and local features intact; add the AccessibilityService only here.

The AccessibilityService should:
- Be disabled until the user enables it.
- Declare only the minimum required accessibility capabilities.
- Operate only while an approved task is active.
- Use visible node labels/content descriptions and current-window context.
- Avoid collecting screen content unrelated to the active task.
- Stop immediately when the task is paused/cancelled or approval expires.

## Server API contract (to implement)

All endpoints require the existing authenticated Worker session and return `Cache-Control: no-store`.

- `POST /api/android/tasks`: create a bounded task from the user's natural-language instruction.
- `GET /api/android/tasks/:id`: fetch plan and progress.
- `POST /api/android/tasks/:id/approve`: record approval for the exact plan version/hash.
- `POST /api/android/tasks/:id/reject`: reject a pending plan.
- `GET /api/android/tasks/:id/next-action`: return the next approved typed action for the companion app.
- `POST /api/android/tasks/:id/action-result`: acknowledge one action result with status and sanitized evidence.
- `POST /api/android/tasks/:id/pause` and `/cancel`: stop further actions.
- `GET /api/android/tasks`: list recent tasks and their status.

The server must reject unknown action types, stale plan hashes, duplicate acknowledgements, expired approvals, oversized payloads, and any attempt to call an unapproved action. No endpoint may accept raw shell commands or arbitrary code.

## Delivery order

1. Add database migration and server-side plan/approval/action state machine.
2. Add authenticated APIs and tests for approval, expiry, ordering, pause/cancel, and invalid actions.
3. Build the standalone Android companion app and permission/onboarding screens.
4. Implement visible Accessibility actions and per-step confirmation.
5. Add live progress/history UI and end-to-end tests with a harmless sample flow (launch YouTube and search a user-specified query; do not auto-play or purchase anything).
6. Open a draft PR. Do not merge or deploy until the user explicitly asks.

## User-selected constraints

- Keep the AI Worker in `mdrafi2038-glitch/Persistent-AI-Agent-Worker`.
- Do not edit any separate Personal Agent repository or app.
- No device registration.
- No browser automation.
- No PC bridge.
- Voice commands are postponed.
- Accessibility-based visible UI assistance is allowed, with user approval and safety boundaries.
