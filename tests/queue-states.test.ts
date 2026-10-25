import test from "node:test";
import assert from "node:assert/strict";
import { isClearableState, isTerminalState } from "../src/core/QueueStates.ts";
import type { QueueState } from "../src/core/QueueStates.ts";

const allStates: QueueState[] = [
  "queued",
  "native_search",
  "waiting_auth",
  "waiting_quota",
  "submitted",
  "pending",
  "downloading",
  "done",
  "review",
  "failed",
  "cancelled"
];

test("only completed, failed, and cancelled records are clearable", () => {
  const clearable = allStates.filter(isClearableState);
  assert.deepEqual(clearable, ["done", "failed", "cancelled"]);
});

test("review remains terminal but is preserved by cleanup", () => {
  assert.equal(isTerminalState("review"), true);
  assert.equal(isClearableState("review"), false);
});

test("active states remain neither terminal nor clearable", () => {
  for (const state of ["queued", "native_search", "waiting_auth", "waiting_quota", "submitted", "pending", "downloading"] as QueueState[]) {
    assert.equal(isTerminalState(state), false, `${state} should remain active`);
    assert.equal(isClearableState(state), false, `${state} should not be cleared`);
  }
});
