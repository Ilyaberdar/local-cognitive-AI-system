import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { shellQuoteArg } from "../src/utils/shellQuote";

test("a shell-quoted argument is one literal to a POSIX shell, so a copy-pasted command cannot inject", () => {
  // The dangerous shapes a web target's path could carry into a suggested sudo command.
  for (const value of ["https://x.com/$(id)", "https://x.com/`id`", "a; rm -rf /", "a b c", "it's", "https://x.com/\"q\"", "$HOME", "a\nb", "normal"]) {
    const quoted = shellQuoteArg(value);
    // sh -c 'printf %s <quoted>' must print exactly the original, with no command run.
    const out = execFileSync("/bin/sh", ["-c", `printf %s ${quoted}`]).toString();
    assert.equal(out, value, value);
  }
});
