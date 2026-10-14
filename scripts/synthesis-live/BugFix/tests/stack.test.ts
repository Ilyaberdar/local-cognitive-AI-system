import assert from "node:assert/strict";
import test from "node:test";
import { Stack } from "../src/stack.ts";

test("pop and peek give the last item pushed", () => {
  const stack = new Stack<number>();
  stack.push(1); stack.push(2); stack.push(3);
  assert.equal(stack.peek(), 3);
  assert.equal(stack.pop(), 3);
  assert.equal(stack.pop(), 2);
  assert.equal(stack.size, 1);
});
test("an empty stack gives undefined", () => { assert.equal(new Stack<string>().pop(), undefined); });
