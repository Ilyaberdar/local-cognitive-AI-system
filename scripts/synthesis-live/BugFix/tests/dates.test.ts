import assert from "node:assert/strict";
import test from "node:test";
import { daysBetween } from "../src/dates.ts";

test("days between two dates, across months and years", () => {
  assert.equal(daysBetween("2026-01-31", "2026-02-01"), 1);
  assert.equal(daysBetween("2026-02-28", "2026-03-01"), 1);
  assert.equal(daysBetween("2025-12-31", "2026-01-01"), 1);
  assert.equal(daysBetween("2026-03-01", "2026-02-01"), -28);
});
