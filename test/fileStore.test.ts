import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renameWithRetry } from "../src/utils/fileStore";

test("a rename that Windows refuses for a moment is tried again; other errors are not", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "file-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const from = path.join(root, "a.tmp"), to = path.join(root, "a.json");
  fs.writeFileSync(from, "{}");
  const original = fs.promises.rename;
  let calls = 0;
  t.mock.method(fs.promises, "rename", async (...args: [string, string]) => {
    if (++calls < 3) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    return original(...args);
  });
  await renameWithRetry(from, to, 6);
  assert.equal(calls, 3);
  assert.equal(fs.readFileSync(to, "utf8"), "{}");
  await assert.rejects(renameWithRetry(path.join(root, "missing"), to, 6), /ENOENT/, "a missing file fails at once");
});
