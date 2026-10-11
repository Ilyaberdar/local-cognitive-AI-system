import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runContractTests, type TestRunRequest } from "../src/synthesis/checks/runners";
import { bwrapArgs, darwinProfile, platformSandbox, sandboxEnv, unsandboxed } from "../src/synthesis/checks/sandbox";
import type { CheckFiles, CheckResult, SandboxProvider } from "../src/synthesis/checks/types";

const sandbox = platformSandbox();
const providers: Array<[string, SandboxProvider]> = [["sandboxed", sandbox], ["unsandboxed", unsandboxed]];
type Files = Partial<CheckFiles> & { suite: Record<string, string> };

/** Runs one check in a fresh work root and proves the run's own folder is gone afterwards. */
async function check(t: TestContext, provider: SandboxProvider, files: Files, tests: string[], options: Partial<TestRunRequest> = {}): Promise<CheckResult | undefined> {
  const why = await provider.unavailable();
  if (why) { t.skip(why); return undefined; }
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lc-checks-"));
  try {
    const result = await runContractTests({ files: { candidate: {}, frozen: {}, ...files }, tests, timeoutMs: 30_000, sandbox: provider, workRoot, ...options });
    assert.deepEqual(await fs.readdir(workRoot), [], "the run's folder is removed");
    // A missing toolchain (python3, a C++ compiler) is the machine's, not the test's.
    if (result.status === "Unknown" && /need/.test(result.message)) { t.skip(result.message); return undefined; }
    return result;
  } finally { await fs.rm(workRoot, { recursive: true, force: true }); }
}
const lineOf = (source: string, text: string) => source.split("\n").findIndex(line => line.includes(text)) + 1;
const noAbsolutePaths = (result: CheckResult) => {
  for (const item of result.feedback) assert.doesNotMatch(item, /\/(?:private|var|tmp|Users|home)\//, item);
  assert.ok(result.feedback.length <= 8 && result.feedback.every(item => item.length <= 300));
};

// TypeScript: a token bucket with an injected clock.
const rateLimiter = `export interface Clock { now(): number }

export class RateLimiter {
  private tokens: number;
  private last: number;
  private readonly capacity: number;
  private readonly perSecond: number;
  private readonly clock: Clock;

  constructor(capacity: number, perSecond: number, clock: Clock) {
    this.capacity = capacity;
    this.perSecond = perSecond;
    this.clock = clock;
    this.tokens = capacity;
    this.last = clock.now();
  }

  tryTake(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  private refill(): void {
    const now = this.clock.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) / 1000 * this.perSecond);
    this.last = now;
  }
}
`;
const rateLimiterTest = `import assert from "node:assert/strict";
import { test } from "node:test";
import { RateLimiter } from "../src/rateLimiter.ts";

const fakeClock = () => {
  let now = 0;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
};

test("allows a burst up to its capacity", () => {
  const limiter = new RateLimiter(3, 1, fakeClock());
  assert.deepEqual([1, 2, 3, 4].map(() => limiter.tryTake()), [true, true, true, false]);
});

test("refills one token per second", () => {
  const clock = fakeClock();
  const limiter = new RateLimiter(2, 1, clock);
  limiter.tryTake();
  limiter.tryTake();
  clock.advance(1000);
  assert.equal(limiter.available(), 1);
});

test("never holds more than its capacity", () => {
  const clock = fakeClock();
  const limiter = new RateLimiter(2, 1, clock);
  clock.advance(10_000);
  assert.equal(limiter.available(), 2);
});
`;
const ts = (source: string): Files => ({ candidate: { "src/rateLimiter.ts": source }, suite: { "tests/rateLimiter.test.ts": rateLimiterTest } });
const tsTests = ["tests/rateLimiter.test.ts"];
const tsUncapped = rateLimiter.replace("Math.min(this.capacity, this.tokens + (now - this.last) / 1000 * this.perSecond)", "this.tokens + (now - this.last) / 1000 * this.perSecond");

// Python: the same limiter, imported as a package path from the work folder.
const pyLimiter = `class RateLimiter:
    def __init__(self, capacity, per_second, clock):
        self.capacity = capacity
        self.per_second = per_second
        self.clock = clock
        self.tokens = float(capacity)
        self.last = clock()

    def _refill(self):
        now = self.clock()
        self.tokens = min(self.capacity, self.tokens + (now - self.last) * self.per_second)
        self.last = now

    def try_take(self):
        self._refill()
        if self.tokens < 1:
            return False
        self.tokens -= 1
        return True

    def available(self):
        self._refill()
        return int(self.tokens)
`;
const pyTest = `import unittest

from src.rate_limiter import RateLimiter


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


class RateLimiterTest(unittest.TestCase):
    def test_burst(self):
        limiter = RateLimiter(3, 1, FakeClock())
        self.assertEqual([limiter.try_take() for _ in range(4)], [True, True, True, False])

    def test_refill(self):
        clock = FakeClock()
        limiter = RateLimiter(2, 1, clock)
        limiter.try_take()
        limiter.try_take()
        clock.now += 1.0
        self.assertEqual(limiter.available(), 1)

    def test_capacity(self):
        clock = FakeClock()
        limiter = RateLimiter(2, 1, clock)
        clock.now += 10.0
        self.assertEqual(limiter.available(), 2)
`;
const py = (source: string): Files => ({ candidate: { "src/rate_limiter.py": source }, suite: { "tests/test_rate_limiter.py": pyTest } });
const pyTests = ["tests/test_rate_limiter.py"];

// C++: a frozen header, a candidate source, tests on the bundled lc_test.hpp.
const counterHeader = `#pragma once
#include <stdexcept>

class Counter {
 public:
  explicit Counter(int limit);
  bool increment();
  int value() const;

 private:
  int limit_;
  int value_ = 0;
};
`;
const counterSource = `#include "Counter.h"

Counter::Counter(int limit) : limit_(limit) {
  if (limit < 0) throw std::invalid_argument("limit must not be negative");
}

bool Counter::increment() {
  if (value_ >= limit_) return false;
  ++value_;
  return true;
}

int Counter::value() const { return value_; }
`;
const counterTest = `#include "lc_test.hpp"
#include "Counter.h"

LC_TEST(starts_at_zero) {
  Counter counter(3);
  LC_CHECK_EQ(counter.value(), 0);
}

LC_TEST(stops_at_its_limit) {
  Counter counter(2);
  for (int i = 0; i < 5; ++i) counter.increment();
  LC_CHECK_EQ(counter.value(), 2);
  LC_CHECK(!counter.increment());
}

LC_TEST(rejects_a_negative_limit) {
  LC_CHECK_THROWS(Counter(-1));
}
`;
const cpp = (source: string): Files => ({ candidate: { "src/Counter.cpp": source }, frozen: { "include/Counter.h": counterHeader }, suite: { "tests/Counter.test.cpp": counterTest } });
const cppTests = ["tests/Counter.test.cpp"];
const cppUnlimited = counterSource.replace("  if (value_ >= limit_) return false;\n", "");

for (const [label, provider] of providers) {
  test(`TypeScript (${label}): a correct candidate passes`, async t => {
    const result = await check(t, provider, ts(rateLimiter), tsTests);
    if (!result) return;
    assert.equal(result.status, "Pass", JSON.stringify(result));
    assert.equal(result.message, "3 of 3 tests passed");
    assert.deepEqual(result.feedback, []);
    assert.deepEqual(result.cases?.map(item => [item.name, item.status, item.file]), [
      ["allows a burst up to its capacity", "pass", "tests/rateLimiter.test.ts"],
      ["refills one token per second", "pass", "tests/rateLimiter.test.ts"],
      ["never holds more than its capacity", "pass", "tests/rateLimiter.test.ts"]
    ]);
  });

  test(`TypeScript (${label}): a buggy candidate fails with the expected and actual values`, async t => {
    const result = await check(t, provider, ts(tsUncapped), tsTests);
    if (!result) return;
    assert.equal(result.status, "Fail");
    assert.equal(result.message, "2 of 3 tests passed");
    assert.equal(result.feedback.length, 1);
    const line = lineOf(rateLimiterTest, 'test("never holds more than its capacity"');
    assert.match(result.feedback[0]!, new RegExp(`^never holds more than its capacity: Expected values to be strictly equal: 12 !== 2 \\(expected 2, actual 12\\) \\[tests/rateLimiter\\.test\\.ts:${line}\\]$`));
    const failed = result.cases?.find(item => item.status === "fail");
    assert.deepEqual([failed?.expected, failed?.actual, failed?.line], ["2", "12", line]);
    noAbsolutePaths(result);
  });

  test(`TypeScript (${label}): a syntax error fails with where it is`, async t => {
    const result = await check(t, provider, ts(rateLimiter.replace("tryTake(): boolean {", "tryTake(: boolean {")), tsTests);
    if (!result) return;
    assert.equal(result.status, "Fail");
    assert.match(result.feedback[0]!, /^tests\/rateLimiter\.test\.ts: SyntaxError \[ERR_INVALID_TYPESCRIPT_SYNTAX\]: .+ \(src\/rateLimiter\.ts:\d+\)/);
    noAbsolutePaths(result);
  });

  test(`TypeScript (${label}): an infinite loop times out`, async t => {
    const result = await check(t, provider, ts(rateLimiter.replace("    this.refill();\n    if (this.tokens < 1) return false;", "    while (this.tokens < 1) this.refill();")), tsTests, { timeoutMs: 1500 });
    if (!result) return;
    assert.equal(result.status, "Fail");
    assert.equal(result.message, "Timed out after 1.5 s");
    assert.deepEqual(result.feedback, ["Timed out after 1.5 s while running tests/rateLimiter.test.ts."]);
  });

  test(`TypeScript (${label}): sealed tests give counts only`, async t => {
    const result = await check(t, provider, ts(tsUncapped), tsTests, { hidden: true });
    if (!result) return;
    assert.equal(result.status, "Fail");
    assert.deepEqual(result.feedback, ["1 of 3 sealed tests failed."]);
    assert.equal(result.message, "2 of 3 tests passed");
    assert.ok(result.cases?.some(item => item.name === "never holds more than its capacity" && item.status === "fail"), "the engineer still sees the case");
  });

  test(`JavaScript (${label}): plain JavaScript runs without type stripping, nested names join with ›`, async t => {
    const suite = `import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { add } from "../src/add.mjs";
describe("add", () => {
  it("adds", () => assert.equal(add(1, 2), 3));
  describe("negatives", () => { it("subtracts", () => assert.equal(add(1, -3), -2)); });
});
test("parent", async t => { await t.test("child", () => assert.equal(add(0, 0), 0)); });
test.skip("skipped", () => {});
test.todo("todo", () => { throw new Error("later"); });
`;
    const result = await check(t, provider, { candidate: { "src/add.mjs": "export const add = (a, b) => a + b;\n" }, suite: { "tests/add.test.mjs": suite } }, ["tests/add.test.mjs"]);
    if (!result) return;
    assert.equal(result.status, "Pass", JSON.stringify(result));
    assert.deepEqual(result.cases?.map(item => item.name), ["add › adds", "add › negatives › subtracts", "parent › child"]);
  });

  test(`JavaScript (${label}): code that exits the process early cannot pass`, async t => {
    const suite = `import { test } from "node:test";
import { ok } from "../src/quit.mjs";
test("never runs", () => { if (!ok) throw new Error("no"); });
`;
    const result = await check(t, provider, { candidate: { "src/quit.mjs": "process.exit(0);\nexport const ok = true;\n" }, suite: { "tests/quit.test.mjs": suite } }, ["tests/quit.test.mjs"]);
    if (!result) return;
    assert.equal(result.status, "Fail");
    assert.match(result.feedback[0]!, /^tests\/quit\.test\.mjs: The file reported no tests/);
  });

  test(`Python (${label}): a correct candidate passes`, async t => {
    const result = await check(t, provider, py(pyLimiter), pyTests);
    if (!result) return;
    assert.equal(result.status, "Pass", JSON.stringify(result));
    assert.equal(result.message, "3 of 3 tests passed");
    assert.deepEqual(result.cases?.map(item => item.name), ["RateLimiterTest › test_burst", "RateLimiterTest › test_capacity", "RateLimiterTest › test_refill"]);
  });

  test(`Python (${label}): a buggy candidate fails with the expected and actual values`, async t => {
    const result = await check(t, provider, py(pyLimiter.replace("min(self.capacity, self.tokens + (now - self.last) * self.per_second)", "self.tokens + (now - self.last) * self.per_second")), pyTests);
    if (!result) return;
    assert.equal(result.status, "Fail");
    assert.equal(result.message, "2 of 3 tests passed");
    const line = lineOf(pyTest, "self.assertEqual(limiter.available(), 2)");
    assert.deepEqual(result.feedback, [`RateLimiterTest › test_capacity: 12 != 2 (expected 2, actual 12) [tests/test_rate_limiter.py:${line}]`]);
    noAbsolutePaths(result);
  });

  test(`Python (${label}): a syntax error fails with where it is`, async t => {
    const result = await check(t, provider, py(pyLimiter.replace("def try_take(self):", "def try_take(self:")), pyTests);
    if (!result) return;
    assert.equal(result.status, "Fail");
    assert.equal(result.cases?.length, 1);
    assert.match(result.feedback[0]!, /^tests\/test_rate_limiter\.py: SyntaxError: .+ \(src\/rate_limiter\.py:\d+\) \[tests\/test_rate_limiter\.py:3\]$/);
    noAbsolutePaths(result);
  });

  test(`Python (${label}): an infinite loop times out and names the test`, async t => {
    const result = await check(t, provider, py(pyLimiter.replace("        self._refill()\n        if self.tokens < 1:", "        while self.tokens < 1:\n            self._refill()\n        if self.tokens < 1:")), pyTests, { timeoutMs: 1500 });
    if (!result) return;
    assert.equal(result.status, "Fail");
    assert.equal(result.message, "Timed out after 1.5 s");
    assert.deepEqual(result.feedback, ["Timed out after 1.5 s while running RateLimiterTest › test_burst."]);
    assert.ok(result.cases?.some(item => item.name === "RateLimiterTest › test_burst" && item.status === "fail"));
  });

  test(`Python (${label}): sealed tests give counts only`, async t => {
    const result = await check(t, provider, py(pyLimiter.replace("return int(self.tokens)", "return int(self.tokens) + 1")), pyTests, { hidden: true });
    if (!result) return;
    assert.equal(result.status, "Fail");
    assert.deepEqual(result.feedback, ["2 of 3 sealed tests failed."]);
    assert.equal(result.cases?.filter(item => item.status === "fail").length, 2);
  });

  test(`C++ (${label}): a correct candidate passes`, async t => {
    const result = await check(t, provider, cpp(counterSource), cppTests);
    if (!result) return;
    assert.equal(result.status, "Pass", JSON.stringify(result));
    assert.equal(result.message, "3 of 3 tests passed");
    assert.deepEqual(result.cases?.map(item => [item.name, item.file, item.line]), [
      ["starts_at_zero", "tests/Counter.test.cpp", 4], ["stops_at_its_limit", "tests/Counter.test.cpp", 9], ["rejects_a_negative_limit", "tests/Counter.test.cpp", 16]
    ]);
  });

  test(`C++ (${label}): a buggy candidate fails with the expected and actual values`, async t => {
    const result = await check(t, provider, cpp(cppUnlimited), cppTests);
    if (!result) return;
    assert.equal(result.status, "Fail");
    assert.equal(result.message, "2 of 3 tests passed");
    assert.deepEqual(result.feedback, ["stops_at_its_limit: LC_CHECK_EQ(counter.value(), 2) failed (expected 2, actual 5) [tests/Counter.test.cpp:12]"]);
  });

  test(`C++ (${label}): a build error fails with the compiler's words`, async t => {
    const result = await check(t, provider, cpp(counterSource.replace("return value_; }", "return value_ }")), cppTests);
    if (!result) return;
    assert.equal(result.status, "Fail");
    // clang: "expected ';' after return statement"; g++: "expected ';' before '}' token".
    assert.match(result.message, /^Build failed: src\/Counter\.cpp:13: expected ';'/);
    assert.match(result.feedback[0]!, /^src\/Counter\.cpp:13:\d+: error: expected ';'/);
    noAbsolutePaths(result);
    const hidden = await check(t, provider, cpp(counterSource.replace("return value_; }", "return value_ }")), cppTests, { hidden: true });
    assert.deepEqual([hidden?.message, hidden?.feedback], ["Build failed", ["The build failed."]]);
  });

  test(`C++ (${label}): an infinite loop times out and names the test`, async t => {
    const result = await check(t, provider, cpp(counterSource.replace("  if (value_ >= limit_) return false;", "  volatile int spin = 0;\n  while (value_ >= limit_) spin = spin + 1;")), cppTests, { timeoutMs: 1500 });
    if (!result) return;
    assert.equal(result.status, "Fail");
    assert.deepEqual([result.message, result.feedback], ["Timed out after 1.5 s", ["Timed out after 1.5 s while running stops_at_its_limit."]]);
  });

  test(`C++ (${label}): a crash names the running test and the abort`, async t => {
    const result = await check(t, provider, cpp(counterSource.replace("  if (value_ >= limit_) return false;", "  if (value_ >= limit_) std::abort();").replace("#include \"Counter.h\"", "#include \"Counter.h\"\n#include <cstdlib>")), cppTests);
    if (!result) return;
    assert.equal(result.status, "Fail");
    assert.equal(result.message, "Crashed (exit 134) after 1 test");
    // macOS's sh reports "Abort trap: 6"; dash may report nothing.
    assert.match(result.feedback[0]!, process.platform === "darwin" ? /^Crashed \(exit 134\) after 1 test while running stops_at_its_limit: Abort trap: 6$/ : /^Crashed \(exit 134\) after 1 test while running stops_at_its_limit/);
    assert.deepEqual(result.cases?.map(item => [item.name, item.status]), [["starts_at_zero", "pass"], ["stops_at_its_limit", "fail"]]);
  });

  test(`C++ (${label}): sealed tests give counts only`, async t => {
    const result = await check(t, provider, cpp(cppUnlimited), cppTests, { hidden: true });
    if (!result) return;
    assert.deepEqual([result.status, result.feedback], ["Fail", ["1 of 3 sealed tests failed."]]);
  });
}

test("C++: the framework reports values, exceptions and several test files", async t => {
  const first = `#include "lc_test.hpp"
#include <stdexcept>
#include <string>
#include <vector>
LC_TEST(text) { std::string word = "a"; LC_CHECK_EQ(word, "b"); }
LC_TEST(near) { LC_CHECK_NEAR(1.5, 1.0, 0.01); }
LC_TEST(throws) { throw std::runtime_error("boom"); }
LC_TEST(sizes) { std::vector<int> items{1, 2, 3}; LC_CHECK_EQ(items.size(), 3); LC_CHECK_EQ(items, (std::vector<int>{1, 2, 3})); }
`;
  const second = `#include "lc_test.hpp"
#include <string>
enum class Color { Red = 1, Blue = 2 };
LC_TEST(c_strings) { const char* a = "same"; char b[] = "same"; LC_CHECK_EQ(a, b); }
LC_TEST(floats) { LC_CHECK_EQ(0.1 + 0.2, 0.3); }
LC_TEST(escapes) { LC_CHECK_EQ(std::string("a\\"b\\\\c\\nd\\te\\x01"), "x"); }
LC_TEST(pointer) { int x = 0; int* p = &x; LC_CHECK_EQ(p, nullptr); }
LC_TEST(enums) { LC_CHECK_EQ(Color::Red, Color::Blue); }
`;
  const result = await check(t, unsandboxed, { suite: { "tests/a.test.cpp": first, "tests/b.test.cpp": second } }, ["tests/a.test.cpp", "tests/b.test.cpp"]);
  if (!result) return;
  assert.equal(result.message, "2 of 9 tests passed");
  const byName = Object.fromEntries((result.cases ?? []).map(item => [item.name, item]));
  assert.deepEqual([byName.text?.expected, byName.text?.actual], ['"b"', '"a"']);
  assert.deepEqual([byName.near?.expected, byName.near?.actual], ["1 +/- 0.01", "1.5"]);
  assert.equal(byName.throws?.message, "Uncaught exception: boom");
  assert.deepEqual([byName.sizes?.status, byName.c_strings?.status], ["pass", "pass"]);
  assert.deepEqual([byName.floats?.expected, byName.floats?.actual], ["0.3", "0.30000000000000004"]);
  assert.equal(byName.escapes?.actual, '"a"b\\c\nd\te\x01"');
  assert.equal(byName.pointer?.expected, "nullptr");
  assert.deepEqual([byName.enums?.expected, byName.enums?.actual], ["2", "1"]);
  assert.deepEqual([byName.text?.file, byName.enums?.file], ["tests/a.test.cpp", "tests/b.test.cpp"]);
});

test("Python: failing subtests are cases of their own", async t => {
  const suite = `import unittest
class Numbers(unittest.TestCase):
    def test_even(self):
        for value in (2, 3, 4):
            with self.subTest(value=value):
                self.assertEqual(value % 2, 0)
`;
  const result = await check(t, unsandboxed, { suite: { "tests/test_numbers.py": suite } }, ["tests/test_numbers.py"]);
  if (!result) return;
  assert.equal(result.status, "Fail");
  assert.deepEqual(result.cases?.map(item => [item.name, item.status, item.line]), [["Numbers › test_even › (value=3)", "fail", 6]]);
});

test("the sandbox keeps the code inside its work folder, away from the home folder and the network", { skip: !["darwin", "linux"].includes(process.platform) }, async t => {
  const why = await sandbox.unavailable();
  if (why) return t.skip(why);
  const probe = await fs.mkdtemp(path.join(os.homedir(), ".lc-sandbox-probe-"));
  const outside = path.join(os.tmpdir(), `lc-sandbox-escape-${process.pid}-${Date.now()}.txt`);
  const beside = `${outside}.host`;
  let connections = 0;
  const server = net.createServer(socket => { connections++; socket.destroy(); });
  try {
    const secret = path.join(probe, "secret.txt");
    await fs.writeFile(secret, "secret");
    await fs.writeFile(beside, "the host's");
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    // macOS refuses with EPERM. bubblewrap shows nothing it does not bind (ENOENT), gives the run a /tmp of
    // its own and a network of its own: a write outside may succeed there, so the host checks it never arrived.
    const suite = `import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
test("writes inside the work folder", () => {
  fs.writeFileSync("inside.txt", "ok");
  assert.equal(fs.readFileSync("inside.txt", "utf8"), "ok");
});
test("cannot see or write outside the work folder", () => {
  assert.equal(fs.existsSync(${JSON.stringify(beside)}), false);
  for (const file of [${JSON.stringify(outside)}, path.join(process.cwd(), "..", "escaped.txt")]) {
    try { fs.writeFileSync(file, "escaped"); } catch (error) { assert.ok(["EPERM", "EACCES", "EROFS"].includes(error.code), error.code); }
  }
});
test("cannot read the home folder", () => {
  assert.throws(() => fs.readFileSync(${JSON.stringify(secret)}, "utf8"));
  assert.throws(() => fs.readdirSync(${JSON.stringify(os.homedir())}));
});
test("cannot connect to 127.0.0.1", async () => {
  const error = await new Promise(resolve => net.connect(${port}, "127.0.0.1").once("connect", () => resolve(undefined)).once("error", resolve));
  assert.ok(error, "connected");
});
`;
    const files = { suite: { "tests/sandbox.test.mjs": suite } }, tests = ["tests/sandbox.test.mjs"];
    // check() also proves the work root holds nothing afterwards: ../escaped.txt never reached it.
    const result = await check(t, sandbox, files, tests);
    assert.equal(result?.status, "Pass", JSON.stringify(result));
    assert.equal(connections, 0);
    await assert.rejects(fs.access(outside), "nothing was written outside");
    // The control: the same tests fail without the sandbox, so they do detect a missing one.
    const control = await check(t, unsandboxed, files, tests);
    assert.deepEqual(control?.cases?.map(item => item.status), ["pass", "fail", "fail", "fail"]);
  } finally {
    server.close();
    await fs.rm(probe, { recursive: true, force: true });
    await fs.rm(outside, { force: true });
    await fs.rm(beside, { force: true });
  }
});

test("on Linux the code under test cannot make user namespaces of its own (bubblewrap 0.8 and later)", { skip: process.platform !== "linux" }, async t => {
  const why = await sandbox.unavailable();
  if (why) return t.skip(why);
  const help = await new Promise<string>(resolve => execFile("bwrap", ["--help"], (_error, stdout) => resolve(String(stdout))));
  if (!help.includes("--disable-userns")) return t.skip("bubblewrap is older than 0.8");
  const suite = `import ctypes
import unittest


class Namespaces(unittest.TestCase):
    def test_cannot_make_a_user_namespace(self):
        self.assertEqual(ctypes.CDLL(None, use_errno=True).unshare(0x10000000), -1)
`;
  const files = { suite: { "tests/test_namespaces.py": suite } }, tests = ["tests/test_namespaces.py"];
  const result = await check(t, sandbox, files, tests);
  if (!result) return;
  assert.equal(result.status, "Pass", JSON.stringify(result));
  // The control: outside the sandbox the same call succeeds wherever user namespaces are allowed.
  const control = await check(t, unsandboxed, files, tests);
  if (control?.status === "Pass") t.diagnostic("user namespaces are off on this machine outside the sandbox too");
  else assert.equal(control?.status, "Fail");
});

test("the macOS profile denies before it allows, with resolved paths", async () => {
  const home = await fs.realpath(os.homedir());
  const nvm = path.join(home, ".nvm", "versions", "node", "v22.18.0", "bin");
  const profile = darwinProfile("/var/folders", [nvm, home, "/", "/Users"]);
  const lines = profile.split("\n");
  assert.deepEqual(lines.slice(0, 3), ["(version 1)", "(allow default)", "(deny network*)"]);
  // No way out through other processes: system services, Apple Events, signals.
  for (const rule of ["(deny mach-lookup)", "(deny appleevent-send)", "(deny signal (target others))", "(deny file-write*)"]) assert.ok(lines.includes(rule), rule);
  // Whether a file exists there is hidden too: access() is file-test-existence, not a read.
  const denied = lines.find(line => line.startsWith("(deny file-read* file-test-existence "))!;
  for (const dir of ["/Users", "/private/var/folders", "/private/tmp", "/private/var/tmp", "/Volumes"]) assert.ok(denied.includes(`(subpath ${JSON.stringify(dir)})`), dir);
  assert.ok(lines.findIndex(line => line.startsWith("(deny file-read*")) < lines.findIndex(line => line.startsWith("(allow file-read*")));
  if (process.platform === "darwin") assert.match(profile, /\(subpath "\/private\/var\/folders"\)/);
  // A tool folder under home opens that folder (and stat on its parents), never home itself or a parent of it.
  const reads = lines.find(line => line.startsWith("(allow file-read* "))!;
  assert.ok(reads.includes(`(subpath ${JSON.stringify(nvm)})`));
  for (const dir of [home, "/", "/Users"]) assert.ok(!reads.includes(`(subpath ${JSON.stringify(dir)})`), dir);
  assert.match(profile, /\(allow file-read-metadata .*\(literal "[^"]*\/\.nvm"\)/);
});

test("the bubblewrap command shares only system folders, the tools' folders and the work folder", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "lc-work-")), tool = await fs.mkdtemp(path.join(os.tmpdir(), "lc-tool-"));
  try {
    const [realWork, realTool] = [await fs.realpath(work), await fs.realpath(tool)];
    const args = bwrapArgs("/usr/bin/python3", ["-I", "x.py"], work, [tool, "/usr/bin", os.homedir(), "/", "/etc/local-cognitive"]);
    assert.deepEqual(args.slice(0, 14), ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--ro-bind", "/usr", "/usr"]);
    assert.deepEqual(args.slice(-9), ["--bind", realWork, realWork, "--chdir", realWork, "--", "/usr/bin/python3", "-I", "x.py"]);
    assert.ok(args.includes(realTool), "the tool's folder is bound read-only");
    for (const hidden of [os.homedir(), "/", "/home", "/root", "/etc/local-cognitive", "/var/lib"]) assert.ok(!args.includes(hidden), hidden);
    assert.equal(args.filter(arg => arg === "/usr/bin").length, 0, "folders under /usr are visible already");
    // bubblewrap 0.8+: no user namespaces of the code's own; an older one runs without the option.
    const blocked = bwrapArgs("/usr/bin/python3", ["-I", "x.py"], work, [tool], true), at = blocked.indexOf("--disable-userns");
    assert.ok(at > 0 && blocked[at - 1] === "--unshare-user", blocked.join(" "));
    assert.deepEqual(blocked.slice(-9), args.slice(-9));
    assert.ok(!args.includes("--disable-userns"));
  } finally { await fs.rm(work, { recursive: true, force: true }); await fs.rm(tool, { recursive: true, force: true }); }
});

test("the sandbox environment holds only what the run sets", async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "lc-env-"));
  try {
    const env = sandboxEnv("/opt/tools/bin/node", work);
    assert.deepEqual(env, {
      PATH: "/opt/tools/bin:/usr/bin:/bin", HOME: work, TMPDIR: path.join(work, "tmp"), LANG: "C.UTF-8",
      PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8",
      ASAN_OPTIONS: "detect_leaks=0:abort_on_error=0", UBSAN_OPTIONS: "print_stacktrace=1:halt_on_error=1"
    });
    assert.ok((await fs.stat(path.join(work, "tmp"))).isDirectory());
  } finally { await fs.rm(work, { recursive: true, force: true }); }
});

test("collisions, mixed languages and a missing sandbox are Unknown, with a reason", async () => {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lc-checks-"));
  const base = { timeoutMs: 5000, sandbox: unsandboxed, workRoot };
  try {
    const collision = await runContractTests({ ...base, files: { candidate: { "tests/a.test.ts": "" }, frozen: {}, suite: { "tests/a.test.ts": "" } }, tests: ["tests/a.test.ts"] });
    assert.deepEqual([collision.status, collision.message], ["Unknown", "tests/a.test.ts is both a candidate file and a test file."]);
    const folder = await runContractTests({ ...base, files: { candidate: { src: "" }, frozen: { "src/a.ts": "" }, suite: { "t.test.ts": "" } }, tests: ["t.test.ts"] });
    assert.deepEqual([folder.status, folder.message], ["Unknown", "src is a candidate file and also the folder of src/a.ts."]);
    const reserved = await runContractTests({ ...base, files: { candidate: {}, frozen: { "lc_test.hpp": "" }, suite: { "t.cpp": "" } }, tests: ["t.cpp"] });
    assert.match(reserved.message, /lc_test\.hpp uses the name lc_test\.hpp/);
    const escape = await runContractTests({ ...base, files: { candidate: { "../x.ts": "" }, frozen: {}, suite: { "t.test.ts": "" } }, tests: ["t.test.ts"] });
    assert.equal(escape.status, "Unknown");
    const mixed = await runContractTests({ ...base, files: { candidate: {}, frozen: {}, suite: { "a.test.ts": "", "b.py": "" } }, tests: ["a.test.ts", "b.py"] });
    assert.match(mixed.message, /mixes node and python/);
    const absent = await runContractTests({ ...base, files: { candidate: {}, frozen: {}, suite: {} }, tests: ["a.test.ts"] });
    assert.equal(absent.status, "Unknown");
    const noSandbox: SandboxProvider = { name: "none", unavailable: async () => "No sandbox here.", wrap: () => { throw new Error("must not run"); } };
    const refused = await runContractTests({ ...base, sandbox: noSandbox, files: { candidate: {}, frozen: {}, suite: { "a.test.ts": "" } }, tests: ["a.test.ts"] });
    assert.deepEqual(refused, { status: "Unknown", message: "No sandbox here.", feedback: [] });
    assert.deepEqual(await fs.readdir(workRoot), []);
  } finally { await fs.rm(workRoot, { recursive: true, force: true }); }
});

test("cancelling a run stops it and removes its folder", async () => {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lc-checks-"));
  try {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(new Error("cancelled")), 500);
    const suite = `import { test } from "node:test";\ntest("waits", () => new Promise(resolve => setTimeout(resolve, 20000)));\n`;
    await assert.rejects(runContractTests({ files: { candidate: {}, frozen: {}, suite: { "w.test.mjs": suite } }, tests: ["w.test.mjs"], timeoutMs: 30_000, sandbox: unsandboxed, workRoot, signal: controller.signal }), /cancelled/);
    assert.ok(Date.now() - started < 10_000);
    assert.deepEqual(await fs.readdir(workRoot), []);
  } finally { await fs.rm(workRoot, { recursive: true, force: true }); }
});
