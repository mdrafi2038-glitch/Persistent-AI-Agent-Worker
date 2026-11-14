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


test("accepts a Facebook feed post only with a matching draft and separate confirmation step", () => {
  const draft = "আজকের দিনটি নতুন কিছু শেখার সুযোগ।";
  const steps = validateSteps([
    { type: "launch_app", packageName: "com.facebook.katana", explanation: "Open Facebook" },
    { type: "tap_visible_node", text: "What's on your mind?", explanation: "Open the feed composer" },
    { type: "type_text", text: draft, explanation: "Enter the drafted post" },
    { type: "wait_for_ui", timeoutMs: 3000, visibleText: "Post", explanation: "Wait for the visible publish control" },
    { type: "confirm_publish", buttonText: "Post", previewText: draft, explanation: "Ask for a separate final confirmation before publishing" }
  ], [{ packageName: "com.facebook.katana", label: "Facebook" }]);
  assert.equal(steps[4].targetPackage, "com.facebook.katana");
  assert.equal(steps[4].previewText, draft);
});

test("rejects Facebook publishing without exact draft and matching visible button", () => {
  const base = [
    { type: "launch_app", packageName: "com.facebook.katana", explanation: "Open Facebook" },
    { type: "tap_visible_node", text: "What's on your mind?", explanation: "Open composer" },
    { type: "type_text", text: "Draft A", explanation: "Enter post draft" },
    { type: "wait_for_ui", timeoutMs: 3000, visibleText: "Post", explanation: "Wait for publish control" }
  ];
  assert.throws(() => validateSteps([...base, { type: "confirm_publish", buttonText: "Post", previewText: "Different draft", explanation: "Confirm post" }]), /exact typed draft/);
  assert.throws(() => validateSteps([...base.slice(0, 3), { type: "wait_for_ui", timeoutMs: 3000, visibleText: "Cancel", explanation: "Wait for wrong control" }, { type: "confirm_publish", buttonText: "Post", previewText: "Draft A", explanation: "Confirm post" }]), /exact typed draft/);
  assert.throws(() => validateSteps([
    { type: "launch_app", packageName: "com.google.android.youtube", explanation: "Open YouTube" },
    { type: "type_text", text: "Draft A", explanation: "Enter text" },
    { type: "wait_for_ui", timeoutMs: 3000, visibleText: "Post", explanation: "Wait for control" },
    { type: "confirm_publish", buttonText: "Post", previewText: "Draft A", explanation: "Confirm post" }
  ]), /only in the Facebook app/);
  assert.throws(() => validateSteps([
    { type: "launch_app", packageName: "com.facebook.katana", explanation: "Open Facebook" },
    { type: "tap_visible_node", text: "Post", explanation: "Publish without confirmation" }
  ]), /consequential action/);
});

test("plan hash is stable regardless of object key order", () => {
  assert.equal(planHash([{ type: "report_state", explanation: "Check", targetPackage: "com.google.android.youtube" }]), planHash([{ targetPackage: "com.google.android.youtube", explanation: "Check", type: "report_state" }]));
});
