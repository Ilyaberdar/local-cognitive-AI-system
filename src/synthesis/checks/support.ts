// The files a contract test run writes next to the tests (nothing is packaged separately). Each prints
// one JSON line per event, read by runners.ts: {"lc":"start"|"case"|"error"|"done", ...}.
// String.raw keeps every backslash for the target language; none of them may contain a backtick or "${".

/** lc-reporter.mjs: a node:test reporter. Test files run in their own processes; it runs in the parent. */
export const LC_NODE_REPORTER = String.raw`// Local Cognitive's node:test reporter for contract tests: one JSON line per test case.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

const cwd = process.cwd();
// Read and removed before any test file runs: the test processes never see it.
const token = process.env.LC_REPORT_TOKEN ?? "";
delete process.env.LC_REPORT_TOKEN;
const clip = (text, limit) => text.length > limit ? text.slice(0, limit - 1) + "…" : text;
const line = value => JSON.stringify({ ...value, t: token }) + "\n";
const relative = file => {
  if (typeof file !== "string" || !file) return undefined;
  // Test names pass through here too: one that merely looks like a URL must not throw.
  try { return path.relative(cwd, file.startsWith("file:") ? fileURLToPath(file) : path.resolve(cwd, file)).split(path.sep).join("/"); } catch { return file; }
};
const show = value => clip(inspect(value, { depth: 4, breakLength: Infinity, maxArrayLength: 20, maxStringLength: 200 }), 200);
// node reports a file as a test of its own only when its process ended abnormally or reported no tests.
const fileLevel = data => data.nesting === 0 && typeof data.file === "string" && relative(data.name) === relative(data.file);
const inWork = file => { const name = relative(file); return !!name && !name.startsWith("..") && !name.includes("node_modules/"); };
const describe = (error, testFile) => {
  // node wraps the test's own error (an AssertionError, a TypeError...) in ERR_TEST_FAILURE.
  const cause = error && typeof error.cause === "object" && error.cause !== null ? error.cause : error;
  if (!cause) return "failed";
  const message = String(cause.message ?? cause);
  if (cause === error || !cause.name || cause.name === "AssertionError") return message;
  // Any other error says where it came from in the code under test (an assertion points at the test).
  const frame = String(cause.stack ?? "").split("\n").map(item => item.match(/((?:file:\/\/)?\/[^():\s]+):(\d+):\d+\)?$/)).find(match => match && inWork(match[1]));
  return cause.name + ": " + message + (frame && relative(frame[1]) !== testFile ? " (" + relative(frame[1]) + ":" + frame[2] + ")" : "");
};
const assertion = error => [error?.cause, error].find(item => item && typeof item === "object" &&
  (item.code === "ERR_ASSERTION" || item.name === "AssertionError") && ("expected" in item || "actual" in item));
// The first error a crashed or unloadable file printed, with where it points in the work folder.
const firstError = text => {
  const lines = text.split("\n");
  const index = lines.findIndex(item => /^\s*(?:Uncaught )?(?:[A-Z][\w$]*)?(?:Error|Exception)\b[^\n]*?: \S/.test(item));
  if (index < 0) return undefined;
  const header = lines.slice(0, index).map(item => item.match(/^((?:file:\/\/)?\/\S+):(\d+)$/)).find(Boolean);
  const frame = lines.slice(index + 1).map(item => item.match(/((?:file:\/\/)?\/[^():\s]+):(\d+):\d+\)?$/)).find(match => match && inWork(match[1]));
  const where = header ?? frame;
  return lines[index].trim() + (where ? " (" + relative(where[1]) + ":" + where[2] + ")" : "");
};

export default async function* lcReporter(source) {
  // Keyed by the relative path: stderr events name a file as given, test events by its absolute path.
  const files = new Map();
  const state = file => {
    const key = relative(file) ?? "";
    if (!files.has(key)) files.set(key, { names: [], parents: [], cases: 0, stderr: "", notes: [] });
    return files.get(key);
  };
  let total = 0, failed = 0;
  for await (const { type, data } of source) {
    if (!data) continue;
    if (type === "test:stderr") {
      const item = state(data.file);
      if (item.stderr.length < 20000) item.stderr += String(data.message);
    } else if (type === "test:diagnostic") {
      const message = String(data.message ?? "");
      if (/Could not find|Cannot find module|failed to (?:load|import)|ERR_(?:MODULE|IMPORT|REQUIRE|UNKNOWN_FILE|INVALID_TYPESCRIPT|UNSUPPORTED_TYPESCRIPT)|SyntaxError/i.test(message)) {
        yield line({ lc: "error", message: clip(message, 500) });
      } else if (data.file && /\bError\b/.test(message)) state(data.file).notes.push(message);
    } else if (type === "test:dequeue" && fileLevel(data)) {
      // Events of a file arrive only when it ends, so a hang can name the file, not the test.
      yield line({ lc: "start", name: relative(data.file), file: relative(data.file) });
    } else if (type === "test:start") {
      const item = state(data.file);
      item.names.length = data.nesting;
      item.names[data.nesting] = data.name;
      item.parents[data.nesting] = false;
    } else if (type === "test:pass" || type === "test:fail") {
      const item = state(data.file), file = relative(data.file), error = data.details?.error;
      if (fileLevel(data)) {
        if (type === "test:pass" && item.cases) continue;
        const how = error?.signal ? "was killed by " + error.signal : error?.exitCode != null ? "exited with code " + error.exitCode : "ended";
        const message = type === "test:pass" ? "The file reported no tests: it defines none, or the code under test ended the process early."
          : firstError(item.stderr) ?? item.notes[0] ?? "The test process " + how + (item.cases ? " after its tests." : " before reporting any test.");
        total++; failed++;
        yield line({ lc: "case", name: file, status: "fail", file, line: 1, message: clip(message, 500) });
        continue;
      }
      if (data.nesting > 0) item.parents[data.nesting - 1] = true;
      if (data.details?.type === "suite" || item.parents[data.nesting] || data.skip || data.todo) continue;
      item.cases++; total++;
      const record = { lc: "case", name: clip([...item.names.slice(0, data.nesting), data.name].join(" › "), 300),
        status: type === "test:pass" ? "pass" : "fail", file, line: data.line };
      if (type === "test:fail") {
        failed++;
        record.message = clip(describe(error, file), 500);
        const values = assertion(error);
        if (values) { record.expected = show(values.expected); record.actual = show(values.actual); }
      }
      yield line(record);
    }
  }
  yield line({ lc: "done", total, failed });
}
`;

/** lc_unittest_runner.py: loads the test files by path (python3 -I ignores the folder of a script). */
export const LC_PYTHON_RUNNER = String.raw`# Local Cognitive's unittest runner for contract tests: one JSON line per test case.
import importlib.util
import json
import os
import sys
import traceback
import unittest

ROOT = os.getcwd()
# Read and removed before the tests import the code under test.
TOKEN = os.environ.pop("LC_REPORT_TOKEN", "")
sys.path.insert(0, ROOT)
OUT = sys.stdout
MODULES = {}  # module name -> test file, relative to ROOT
SEPARATOR = " › "


def emit(kind, **fields):
    record = {"lc": kind}
    record.update((key, value) for key, value in fields.items() if value is not None)
    record["t"] = TOKEN
    OUT.write(json.dumps(record) + "\n")
    OUT.flush()


def clip(text, limit):
    text = str(text)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def shown(value):
    try:
        return clip(repr(value), 200)
    except Exception:
        return "<unprintable>"


def relative(filename):
    if not filename or filename.startswith("<"):  # <frozen importlib._bootstrap>, <string>
        return None
    absolute = os.path.abspath(filename)
    return os.path.relpath(absolute, ROOT).replace(os.sep, "/") if absolute.startswith(ROOT + os.sep) else None


def location(tb, prefer=None):
    """(file, line) of the deepest frame in prefer (a test file), else of the deepest one in the work folder."""
    frames = [(relative(frame.filename), frame.lineno) for frame in traceback.extract_tb(tb)]
    frames = [frame for frame in frames if frame[0] and frame[0] != "lc_unittest_runner.py"]
    for frame in reversed(frames):
        if frame[0] == prefer:
            return frame
    return frames[-1] if frames else (None, None)


def described(kind, value, tb, test_file):
    if issubclass(kind, SyntaxError) and getattr(value, "filename", None):
        where = relative(value.filename) or os.path.basename(value.filename)
        return "%s: %s (%s:%s)" % (kind.__name__, value.msg, where, value.lineno)
    text = traceback.format_exception_only(kind, value)[-1].strip()
    message = str(value) if issubclass(kind, AssertionError) and str(value) else text
    file, line = location(tb)
    return message + (" (%s:%s)" % (file, line) if file and file != test_file else "")


def capture(method):
    """Keeps the values an equality assertion compared, as (actual, expected)."""
    def checked(self, first, second, *args, **kwargs):
        try:
            return method(self, first, second, *args, **kwargs)
        except self.failureException as error:
            error.lc_values = (first, second)
            raise
    return checked


for _name in ("assertEqual", "assertAlmostEqual", "assertListEqual", "assertTupleEqual", "assertDictEqual",
              "assertSetEqual", "assertSequenceEqual", "assertMultiLineEqual", "assertCountEqual"):
    setattr(unittest.TestCase, _name, capture(getattr(unittest.TestCase, _name)))


def name_of(test):
    if isinstance(test, unittest.case._SubTest):
        return name_of(test.test_case) + SEPARATOR + test._subDescription()
    method = getattr(test, "_testMethodName", None)
    if method is None:  # a failed setUpClass or setUpModule
        text = str(getattr(test, "description", test))
        for module in MODULES:
            text = text.replace(module + ".", "")
        return text
    return type(test).__name__ + SEPARATOR + method


def file_of(test):
    if isinstance(test, unittest.case._SubTest):
        test = test.test_case
    if getattr(test, "_testMethodName", None) is None:
        text = str(getattr(test, "description", ""))
        return next((path for module, path in MODULES.items() if module + "." in text or text.endswith(module + ")")), None)
    return MODULES.get(type(test).__module__)


def definition_line(test):
    if isinstance(test, unittest.case._SubTest):
        test = test.test_case
    code = getattr(getattr(type(test), getattr(test, "_testMethodName", "") or "", None), "__code__", None)
    return code.co_firstlineno if code else None


class Result(unittest.TestResult):
    def __init__(self):
        super().__init__()
        self.total = 0
        self.failed = 0

    def startTest(self, test):
        super().startTest(test)
        emit("start", name=name_of(test), file=file_of(test))

    def addSuccess(self, test):
        super().addSuccess(test)
        self.report(test, "pass")

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self.report(test, "fail", err)

    def addError(self, test, err):  # errors count as failures
        super().addError(test, err)
        self.report(test, "fail", err)

    def addSubTest(self, test, subtest, err):
        super().addSubTest(test, subtest, err)
        if err is not None:
            self.report(subtest, "fail", err)

    def addExpectedFailure(self, test, err):
        super().addExpectedFailure(test, err)
        self.report(test, "pass")

    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        self.report(test, "fail", message="Passed, but it is marked expectedFailure.")

    def report(self, test, status, err=None, message=None):
        file, line, values = file_of(test), None, None
        if err is not None:
            kind, value, tb = err
            message = described(kind, value, tb, file)
            where = location(tb, file)
            line = where[1] if where[0] == file else None
            values = getattr(value, "lc_values", None)
        self.total += 1
        self.failed += status == "fail"
        emit("case", name=name_of(test), status=status, file=file, line=line or definition_line(test),
             message=clip(message, 500) if message else None,
             expected=shown(values[1]) if values else None, actual=shown(values[0]) if values else None)


def load(index, path):
    name = "lc_suite_%d" % index
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    MODULES[name] = path
    spec.loader.exec_module(module)
    return unittest.defaultTestLoader.loadTestsFromModule(module)


def main(paths):
    result = Result()
    for index, path in enumerate(paths):
        try:
            suite = load(index, path)
        except BaseException:  # an exit during import is a failed load too
            kind, value, tb = sys.exc_info()
            where = location(tb, path)
            line = where[1] if where[0] == path else None
            if issubclass(kind, SyntaxError) and relative(getattr(value, "filename", None)) == path:
                line = value.lineno
            result.total += 1
            result.failed += 1
            emit("case", name=path, status="fail", file=path, line=line or 1, message=clip(described(kind, value, tb, path), 500))
            continue
        suite.run(result)
    emit("done", total=result.total, failed=result.failed)
    return 1 if result.failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
`;

/** lc_test.hpp: a header-only C++17 test framework; the run compiles it into ./lc_tests. */
export const LC_TEST_HPP = String.raw`// lc_test.hpp: Local Cognitive's header-only C++17 test framework for contract tests.
// LC_TEST(name) registers a test; main() runs them in order and prints one JSON line per test.
#ifndef LC_TEST_HPP
#define LC_TEST_HPP
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <iterator>
#include <limits>
#include <ostream>
#include <sstream>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

namespace lc_test {
struct Failure { std::string message, expected, actual; const char* file; int line; };
struct Test { const char* name; const char* file; int line; void (*run)(); };
inline std::vector<Test>& registry() { static std::vector<Test> tests; return tests; }
struct Registrar {
  Registrar(const char* name, const char* file, int line, void (*run)()) { registry().push_back(Test{name, file, line, run}); }
};

// Thrown by a failed check: it stops the test. Not a std::exception, so test code catching those keeps it.
[[noreturn]] inline void fail(const char* file, int line, std::string message, std::string expected = std::string(), std::string actual = std::string()) {
  throw Failure{std::move(message), std::move(expected), std::move(actual), file, line};
}

template <typename T, typename = void> struct Printable : std::false_type {};
template <typename T> struct Printable<T, std::void_t<decltype(std::declval<std::ostream&>() << std::declval<const T&>())>> : std::true_type {};
template <typename T, typename = void> struct Iterable : std::false_type {};
template <typename T> struct Iterable<T, std::void_t<decltype(std::begin(std::declval<const T&>())), decltype(std::end(std::declval<const T&>()))>> : std::true_type {};
template <typename T> struct IsPair : std::false_type {};
template <typename A, typename B> struct IsPair<std::pair<A, B>> : std::true_type {};

inline std::string clip(std::string text, std::size_t limit = 200) {
  if (text.size() > limit) { text.resize(limit - 3); text += "..."; }
  return text;
}

template <typename T> std::string show(const T& value) {
  using V = std::decay_t<T>;
  if constexpr (std::is_array_v<T> && std::is_same_v<std::remove_cv_t<std::remove_extent_t<T>>, char>) {
    const std::string text(value, std::extent_v<T>);
    return "\"" + text.substr(0, text.find('\0')) + "\"";
  }
  else if constexpr (std::is_same_v<V, const char*> || std::is_same_v<V, char*>) return value ? "\"" + std::string(value) + "\"" : std::string("nullptr");
  else if constexpr (std::is_same_v<V, std::string> || std::is_same_v<V, std::string_view>) return "\"" + std::string(value) + "\"";
  else if constexpr (std::is_same_v<V, bool>) return value ? "true" : "false";
  else if constexpr (std::is_null_pointer_v<V>) return "nullptr";
  else if constexpr (std::is_same_v<V, char>) return std::string("'") + value + "'";
  else if constexpr (std::is_same_v<V, signed char> || std::is_same_v<V, unsigned char>) return std::to_string(static_cast<int>(value));
  else if constexpr (std::is_floating_point_v<V>) {
    // The short form unless it hides a difference: 0.1 stays 0.1, 0.30000000000000004 stays visible.
    char text[64];
    std::snprintf(text, sizeof text, "%.*Lg", std::numeric_limits<V>::digits10, static_cast<long double>(value));
    if (static_cast<V>(std::strtold(text, nullptr)) != value) std::snprintf(text, sizeof text, "%.*Lg", std::numeric_limits<V>::max_digits10, static_cast<long double>(value));
    return text;
  }
  else if constexpr (std::is_enum_v<V>) return show(static_cast<std::underlying_type_t<V>>(value));
  else if constexpr (IsPair<V>::value) return "(" + show(value.first) + ", " + show(value.second) + ")";
  else if constexpr (Printable<V>::value) { std::ostringstream out; out << value; return out.str(); }
  else if constexpr (Iterable<V>::value) {
    std::string text = "{";
    std::size_t count = 0;
    for (const auto& item : value) {
      if (count == 20) { text += ", ..."; break; }
      text += (count++ ? ", " : "") + show(item);
    }
    return text + "}";
  }
  else return "(not printable)";
}

template <typename A, typename B> bool equal(const A& a, const B& b) {
  using X = std::decay_t<A>;
  using Y = std::decay_t<B>;
  constexpr bool text = (std::is_same_v<X, const char*> || std::is_same_v<X, char*>) && (std::is_same_v<Y, const char*> || std::is_same_v<Y, char*>);
  constexpr bool integers = std::is_integral_v<X> && std::is_integral_v<Y> && !std::is_same_v<X, bool> && !std::is_same_v<Y, bool>;
  if constexpr (text) {
    // C strings compare by text, not by address.
    const char* x = a;
    const char* y = b;
    return x && y ? std::strcmp(x, y) == 0 : x == y;
  }
  else if constexpr (integers) {
    // Mixed signedness compares values, as std::cmp_equal does: size() == 3 just works.
    if constexpr (std::is_signed_v<X> == std::is_signed_v<Y>) return a == b;
    else if constexpr (std::is_signed_v<X>) return a >= 0 && static_cast<std::make_unsigned_t<X>>(a) == b;
    else return b >= 0 && a == static_cast<std::make_unsigned_t<Y>>(b);
  }
  else return a == b;
}

inline std::string json(const std::string& text) {
  std::string out = "\"";
  for (unsigned char c : text) {
    if (c == '"') out += "\\\"";
    else if (c == '\\') out += "\\\\";
    else if (c == '\n') out += "\\n";
    else if (c == '\r') out += "\\r";
    else if (c == '\t') out += "\\t";
    else if (c < 0x20 || c == 0x7f) { char code[8]; std::snprintf(code, sizeof code, "\\u%04x", c); out += code; }
    else out += static_cast<char>(c);
  }
  return out + "\"";
}

// The run's token, taken from the environment and removed when the tests start.
inline std::string& token() { static std::string value; return value; }

// One line per event, signed with the token and flushed at once: a crash must not lose what came before it.
inline void emit(const std::string& record) {
  const std::string line = record.substr(0, record.size() - 1) + ",\"t\":" + json(token()) + "}";
  std::fwrite(line.data(), 1, line.size(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}

inline int run_all() {
  if (const char* value = std::getenv("LC_REPORT_TOKEN")) { token() = value; unsetenv("LC_REPORT_TOKEN"); }
  int total = 0, failed = 0;
  for (const Test& test : registry()) {
    emit("{\"lc\":\"start\",\"name\":" + json(test.name) + ",\"file\":" + json(test.file) + "}");
    std::string status = "pass", message, expected, actual;
    const char* file = test.file;
    int line = test.line;
    try { test.run(); }
    catch (const Failure& failure) {
      status = "fail"; message = failure.message; expected = failure.expected; actual = failure.actual; file = failure.file; line = failure.line;
    }
    catch (const std::exception& error) { status = "fail"; message = std::string("Uncaught exception: ") + error.what(); }
    catch (...) { status = "fail"; message = "Uncaught exception of a type not derived from std::exception."; }
    ++total;
    if (status == "fail") ++failed;
    std::string record = "{\"lc\":\"case\",\"name\":" + json(test.name) + ",\"status\":\"" + status + "\",\"file\":" + json(file) + ",\"line\":" + std::to_string(line);
    if (!message.empty()) record += ",\"message\":" + json(clip(message, 500));
    if (!expected.empty() || !actual.empty()) record += ",\"expected\":" + json(clip(expected)) + ",\"actual\":" + json(clip(actual));
    emit(record + "}");
  }
  emit("{\"lc\":\"done\",\"total\":" + std::to_string(total) + ",\"failed\":" + std::to_string(failed) + "}");
  return failed ? 1 : 0;
}
}  // namespace lc_test

#define LC_TEST_JOIN2(a, b) a##b
#define LC_TEST_JOIN(a, b) LC_TEST_JOIN2(a, b)
#define LC_TEST(name) \
  static void LC_TEST_JOIN(lc_test_body_, name)(); \
  static const ::lc_test::Registrar LC_TEST_JOIN(lc_test_registrar_, name)(#name, __FILE__, __LINE__, &LC_TEST_JOIN(lc_test_body_, name)); \
  static void LC_TEST_JOIN(lc_test_body_, name)()

#define LC_CHECK(...) \
  do { \
    if (!static_cast<bool>(__VA_ARGS__)) ::lc_test::fail(__FILE__, __LINE__, "LC_CHECK(" #__VA_ARGS__ ") failed"); \
  } while (0)

#define LC_CHECK_EQ(actual, expected) \
  do { \
    const auto& lc_actual_ = (actual); \
    const auto& lc_expected_ = (expected); \
    if (!::lc_test::equal(lc_actual_, lc_expected_)) \
      ::lc_test::fail(__FILE__, __LINE__, "LC_CHECK_EQ(" #actual ", " #expected ") failed", ::lc_test::show(lc_expected_), ::lc_test::show(lc_actual_)); \
  } while (0)

#define LC_CHECK_NEAR(actual, expected, eps) \
  do { \
    const auto lc_actual_ = (actual); \
    const auto lc_expected_ = (expected); \
    const auto lc_eps_ = (eps); \
    if (!(std::fabs(static_cast<long double>(lc_actual_) - static_cast<long double>(lc_expected_)) <= static_cast<long double>(lc_eps_))) \
      ::lc_test::fail(__FILE__, __LINE__, "LC_CHECK_NEAR(" #actual ", " #expected ", " #eps ") failed", \
        ::lc_test::show(lc_expected_) + " +/- " + ::lc_test::show(lc_eps_), ::lc_test::show(lc_actual_)); \
  } while (0)

#define LC_CHECK_THROWS(...) \
  do { \
    bool lc_threw_ = false; \
    try { static_cast<void>(__VA_ARGS__); } \
    catch (const ::lc_test::Failure&) { throw; } \
    catch (...) { lc_threw_ = true; } \
    if (!lc_threw_) ::lc_test::fail(__FILE__, __LINE__, "LC_CHECK_THROWS(" #__VA_ARGS__ ") did not throw"); \
  } while (0)

#ifndef LC_TEST_NO_MAIN
// Weak, so several test files can include this header and the program still has one main().
__attribute__((weak)) int main() { return ::lc_test::run_all(); }
#endif
#endif
`;
