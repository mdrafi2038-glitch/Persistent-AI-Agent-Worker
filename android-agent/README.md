# Persistent AI Agent — Android app

Native Android shell plus embedded AI chat for the existing Render worker.

- App package: `com.persistentagent.mobile`
- Min Android: 10 (API 29); tested target is OPPO CPH2473 / Android 12.
- AI Chat opens the existing Render web app at `https://persistent-ai-agent-worker.onrender.com`. It uses the web app's existing login; API keys are not embedded in the APK.
- Native helpers: launch an app by its visible name, open Android settings, use Android speech recognition, and schedule local reminders with Done/Snooze actions.
- Foreground notification indicates the app's foreground service is active. Android/ColorOS may still limit background work; this is not a bypass of system permissions.
- The first run asks for microphone and notification permissions. Exact alarm access may require a separate Android settings confirmation.
- The current command parser intentionally only runs a small set of clear, local actions. Unknown instructions open AI Chat instead of executing arbitrary actions.

## Build
GitHub Actions workflow `.github/workflows/android-apk.yml` builds a debug APK on push or manual dispatch. Download `Persistent-AI-Agent-debug-apk` from the workflow run's Artifacts section. Debug APK is for testing; production distribution should use a protected signing key.
