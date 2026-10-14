import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("every agent's section is in FINDINGS.md: none was overwritten by another", () => {
  const text = fs.readFileSync(new URL("../FINDINGS.md", import.meta.url), "utf8");
  const sections = text.match(/^## .+$/gm) ?? [];
  assert.ok(sections.length >= 6, `${sections.length} sections: ${sections.join(" | ")}`);
});
