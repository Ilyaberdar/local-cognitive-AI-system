import assert from "node:assert/strict";
import test from "node:test";
import { ModeDetector } from "../src/core/ModeDetector";

test("auto mode reads whole words: a task with 'improve' or 'confirm' is not a debate", () => {
  const detector = new ModeDetector();
  assert.equal(detector.detect("Look at the Blender scene, improve the house and confirm the result."), "general");
  assert.equal(detector.detect("Describe the project and its process."), "general");
  assert.equal(detector.detect("Decode this and render it rapidly."), "general");
  assert.equal(detector.detect("List the pros and cons of Rust."), "hypothesis");
  assert.equal(detector.detect("What if we move the server?"), "hypothesis");
  assert.equal(detector.detect("Fix the bug in this function."), "code");
  assert.equal(detector.detect("The API returns errors."), "code");
  assert.equal(detector.detect("Заспавни сабагента для ревью"), "code");
});
