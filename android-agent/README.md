# Persistent AI Agent — Android companion app

Native Android companion app for the existing Persistent AI Agent Worker.

- App package: `com.persistentagent.mobile`
- Minimum Android: 10 (API 29); target SDK: 35.
- Brand-independent design: no OPPO/ColorOS-only onboarding or APIs. Android OEMs may still vary in Accessibility behavior and background limits.
- AI Chat opens the existing Render web app at `https://persistent-ai-agent-worker.onrender.com`. It uses the Worker login; API keys are not embedded in the APK.
- Native helpers include local app launch by visible name, Android settings shortcuts, and local reminders. Voice commands remain postponed and the app does not request microphone permission.
- The optional Accessibility service is inactive until the user enables it. It runs only while an approved task is active and only when the current visible app matches the approved plan.
- The first run may request notification permission. Exact-alarm and background behavior are governed by Android system settings; the app does not bypass them.

## Build

GitHub Actions workflow `.github/workflows/android-apk.yml` builds a debug APK on push or manual dispatch. Download `Persistent-AI-Agent-debug-apk` from the workflow run's Artifacts section. Debug APK is for testing; production distribution should use a protected signing key.

## Visible UI task execution

The Worker exposes authenticated task planning and approval routes under `/api/android/tasks`. See `android-agent/API.md` and the Supabase migrations for the API and schema.

The AI can plan visible interactions in normal installed apps using a strict typed action vocabulary. Each task is previewed for approval, expires after ten minutes, and is dispatched one action at a time. The Android app checks the installed launch activity and verifies that the visible window belongs to the approved app before interacting. Search/query text entry is limited to a focused visible field.

The initial example remains YouTube search: open YouTube, search the user's requested phrase, and report the visible results; do not tap a video result or auto-play. Other apps are supported only where their visible controls are exposed to Accessibility and the plan stays within the safety allowlist.

No device registration, browser automation, PC bridge, voice commands, arbitrary shell/code, hidden interaction, or automatic consequential actions are included. A successful CI build is not a substitute for physical-device testing.
