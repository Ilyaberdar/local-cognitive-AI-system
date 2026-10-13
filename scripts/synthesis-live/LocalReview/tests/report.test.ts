import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const at = (file: string) => new URL(`../${file}`, import.meta.url);

test("REPORT.md gathers the findings with references to the sources", () => {
  const report = fs.readFileSync(at("REPORT.md"), "utf8");
  assert.match(report, /^#\s+\S/m, "REPORT.md has a title");
  const cited = new Set(report.match(/src\/synthesis\/[\w/.-]+\.ts/g) ?? []);
  assert.ok(cited.size >= 3, `REPORT.md cites ${cited.size} source files`);
});

test("the agents left their notes", () => {
  const notes = fs.readdirSync(at("notes")).filter(name => name.endsWith(".md"));
  assert.ok(notes.length >= 3, `${notes.length} notes`);
});
