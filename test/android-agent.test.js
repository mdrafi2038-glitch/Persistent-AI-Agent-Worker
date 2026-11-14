const test = require("node:test");
const assert = require("node:assert/strict");
const { validateSteps, planHash } = require("../android-agent/api");

test("accepts a visible UI plan for an installed-app target", () => {
  const steps = validateSteps([
    { type: "launch_app", packageName: "com.google.android.youtube", explanation: "Open YouTube" },
    { type: "find_visible_text", text: "Search", explanation: "Find the visible search control" },
    { type: "tap_visible_node", text: "Search", explanation: "Open search" },
    { type: "type_text", text: "instrumental music", explanation: "Enter the requested search" },
    { type: "press_enter", explanation: "Submit the search" },
    { type: "wait_for_ui", timeoutMs: 3000, visibleText: "Results", explanation: "Wait for search results" },
    { type: "report_state", explanation: "Report the visible app state" }
  ]);
  assert.equal(steps.length, 7);
  assert.equal(steps[1].targetPackage, "com.google.android.youtube");
  assert.equal(planHash(steps).length, 64);
});

test("accepts another normal app package and binds actions to it", () => {
  const steps = validateSteps([
    { type: "launch_app", packageName: "com.google.android.apps.maps", explanation: "Open Maps" },
    { type: "find_visible_text", text: "Search here", explanation: "Find the visible search field" }
  ]);
  assert.equal(steps[1].targetPackage, "com.google.android.apps.maps");
});

test("rejects system settings, invalid packages, and arbitrary action types", () => {
  assert.throws(() => validateSteps([{ type: "launch_app", packageName: "com.android.settings", explanation: "Open settings" }]), /eligible installed-app/);
  assert.throws(() => validateSteps([{ type: "launch_app", packageName: "com.google.android.permissioncontroller", explanation: "Open permission UI" }]), /eligible installed-app/);
  assert.throws(() => validateSteps([{ type: "launch_app", packageName: "not a package", explanation: "Open app" }]), /eligible installed-app/);
  assert.throws(() => validateSteps([{ type: "run_shell", command: "id", explanation: "Run command" }]), /Unsupported action/);
});

test("restricts app launch to the command-matched installed app list when provided", () => {
  assert.throws(() => validateSteps([
    { type: "launch_app", packageName: "com.spotify.music", explanation: "Open Spotify" }
  ], [{ packageName: "com.google.android.youtube", label: "YouTube" }]), /not in this phone's installed-app list/);
  assert.equal(validateSteps([
    { type: "launch_app", packageName: "com.spotify.music", explanation: "Open Spotify" }
  ], [{ packageName: "com.spotify.music", label: "Spotify" }])[0].packageName, "com.spotify.music");
});

test("rejects visible interactions without a launched app", () => {
  assert.throws(() => validateSteps([{ type: "tap_visible_node", text: "Search", explanation: "Tap search" }]), /Launch an app/);
});

test("rejects consequential controls and credential-like typed text", () => {
  assert.throws(() => validateSteps([
    { type: "launch_app", packageName: "com.google.android.youtube", explanation: "Open app" },
    { type: "tap_visible_node", text: "Buy now", explanation: "Buy" }
  ]), /consequential action/);
  assert.throws(() => validateSteps([
    { type: "launch_app", packageName: "com.google.android.youtube", explanation: "Open app" },
    { type: "tap_visible_node", text: "Allow", explanation: "Grant app permission" }
  ]), /consequential action/);
  assert.throws(() => validateSteps([
    { type: "launch_app", packageName: "com.google.android.youtube", explanation: "Open app" },
    { type: "type_text", text: "OTP 123456", explanation: "Enter code" }
  ]), /non-sensitive/);
});

test("rejects oversized plans and invalid waits", () => {
  assert.throws(() => validateSteps(Array.from({ length: 21 }, () => ({ type: "report_state", explanation: "Read state" }))), /1 to 20/);
  assert.throws(() => validateSteps([
    { type: "launch_app", packageName: "com.google.android.youtube", explanation: "Open app" },
    { type: "wait_for_ui", timeoutMs: 20000, explanation: "Wait too long" }
  ]), /250 and 10,000/);
});

test("plan hash is stable regardless of object key order", () => {
  assert.equal(planHash([{ type: "report_state", explanation: "Check", targetPackage: "com.google.android.youtube" }]), planHash([{ targetPackage: "com.google.android.youtube", explanation: "Check", type: "report_state" }]));
});


test("supports bounded visible scrolling in any approved installed app", () => {
  const steps = validateSteps([
    { type: "launch_app", packageName: "com.google.android.apps.maps", explanation: "Open Maps" },
    { type: "scroll_forward", explanation: "Scroll the visible map results" },
    { type: "scroll_backward", explanation: "Return to the previous visible section" },
    { type: "report_state", explanation: "Report the current app state" }
  ], [{ packageName: "com.google.android.apps.maps", label: "Maps" }]);
  assert.equal(steps[1].targetPackage, "com.google.android.apps.maps");
  assert.equal(steps[2].targetPackage, "com.google.android.apps.maps");
});

test("keeps generic visible UI plans blocked from consequential controls", () => {
  assert.throws(() => validateSteps([
    { type: "launch_app", packageName: "com.example.app", explanation: "Open app" },
    { type: "tap_visible_node", text: "Send", explanation: "Send a message" }
  ]), /consequential action/);
});
