# Android Bridge v1 — Foundation

This increment establishes an authenticated, read-only connection between the native Android app and the Render Worker.

## Included
- `GET /api/android/bridge/capabilities` is protected by the existing signed-in session.
- The Android app reuses the HttpOnly session cookie from its embedded AI Chat WebView.
- The app can verify the server session and display the supported on-device capability IDs.
- The endpoint sends `Cache-Control: no-store` and returns no secrets.

## Deliberate safety boundary
This is **capability discovery only**. It does not accept commands, execute remote actions, run shell commands, simulate taps, or use Accessibility Service. The app's existing local actions remain user-initiated.

## Next implementation stages
1. Device registration and revocable device identity.
2. A server-side approval queue for narrowly scoped actions.
3. Android polling/acknowledgement for approved actions only.
4. Per-action confirmation on the phone and an auditable result record.

Do not skip the phone confirmation or expose an endpoint that can execute arbitrary instructions.
