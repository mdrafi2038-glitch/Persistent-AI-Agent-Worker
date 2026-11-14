const test = require("node:test");
const assert = require("node:assert/strict");
const { validateSteps, planHash } = require("../android-agent/api");

test("accepts a bounded YouTube visible UI plan", () => {
  const steps = validateSteps([
    { type: "launch_app", packageName: "com.google.android.youtube", explanation: "Open YouTube" },
    { type: "find_visible_text", text: "Search", explanation: "Find the visible search control" },
    { type: "tap_visible_node", text: "Search", explanation: "Open search" },
    { type: "type_text", text: "instrumental music", explanation: "Enter the requested search" },
    { type: "press_enter", explanation: "Submit the search" }
  ]);
  assert.equal(steps.length, 5);
  assert.equal(planHash(steps).length, 64);
});

test("rejects arbitrary packages and action types", () => {
  assert.throws(() => validateSteps([{ type: "launch_app", packageName: "com.example.other", explanation: "Open app" }]), /allowed-app/);
  assert.throws(() => validateSteps([{ type: "run_shell", command: "id", explanation: "Run command" }]), /Unsupported action/);
});

test("rejects credential-like typed text and oversized plans", () => {
  assert.throws(() => validateSteps([{ type: "type_text", text: "OTP 123456", explanation: "Enter code" }]), /non-sensitive/);
  assert.throws(() => validateSteps(Array.from({ length: 21 }, () => ({ type: "report_state", explanation: "Read state" }))), /1 to 20/);
});

test("plan hash is stable regardless of object key order", () => {
  assert.equal(planHash([{ type: "report_state", explanation: "Check", timeout: 2 }]), planHash([{ timeout: 2, explanation: "Check", type: "report_state" }]));
});

test("allows only the YouTube search control to be tapped", () => {
  assert.equal(validateSteps([
    { type: "tap_visible_node", text: "Search", explanation: "Open YouTube search" }
  ])[0].text, "Search");
  assert.throws(() => validateSteps([
    { type: "tap_visible_node", text: "Song result", explanation: "Open a result" }
  ]), /Only the visible YouTube search control/);
  assert.throws(() => validateSteps([
    { type: "tap_visible_node", text: "Buy", explanation: "Purchase" }
  ]), /Only the visible YouTube search control/);
});
