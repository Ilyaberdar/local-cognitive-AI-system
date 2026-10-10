import assert from "node:assert/strict";
import test from "node:test";
import { printable, printableDeep, printableMessage } from "../src/server/terminalText";

test("text from outside cannot drive the admin's terminal: escapes, OSC 52, C1 controls and bidi overrides are neutralised", () => {
  assert.equal(printable("Mallory\u001b]52;c;cm0gLXJmIC8=\u0007\u001b[2J"), "Mallory�]52;c;cm0gLXJmIC8=��[2J");
  assert.equal(printable("CSI\u009b31m"), "CSI�31m", "a single-byte CSI too");
  assert.equal(printable("evil\u202egpj.exe"), "evil�gpj.exe", "no right-to-left override");
  assert.equal(printable("two\nlines"), "two�lines", "a name stays on its line");
  assert.equal(printable("Alice's MacBook — ok ✓"), "Alice's MacBook — ok ✓", "ordinary text is untouched");
  assert.equal(printableMessage("line one\n\tline two\u001b[1m"), "line one\n\tline two�[1m");
  assert.deepEqual(printableDeep({ a: ["x\u001b", { b: "y\u0007" }], n: 3, ok: true, none: null }), { a: ["x�", { b: "y�" }], n: 3, ok: true, none: null });
});
