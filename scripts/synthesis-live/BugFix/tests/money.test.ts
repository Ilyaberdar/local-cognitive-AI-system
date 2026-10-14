import assert from "node:assert/strict";
import test from "node:test";
import { formatMoney } from "../src/money.ts";

test("cents always have two digits", () => {
  assert.equal(formatMoney(105), "$1.05");
  assert.equal(formatMoney(1000), "$10.00");
  assert.equal(formatMoney(7), "$0.07");
});
test("a negative amount puts the sign before the dollar", () => {
  assert.equal(formatMoney(-250), "-$2.50");
  assert.equal(formatMoney(-5), "-$0.05");
});
