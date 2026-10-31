import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const assets = path.resolve("public/assets");
const css = (name: string) => fs.readFileSync(path.join(assets, name), "utf8");

test("on a display under 2x, nothing hovered is lifted, so its edge never leaves a resting cursor and the cursor does not flicker", () => {
  // A Mac with a 1x external monitor: buttons lifted a pixel on hover made the cursor jump between the arrow and the hand (2026-10-31).
  const shell = css("settings-shell.css");
  const rule = /@media \(max-resolution: 1\.99dppx\) \{\s*:is\(([^)]*\([^)]*\)[^)]*)\):hover:not\(:active\) \{ transform: none !important; \}/.exec(shell);
  assert.ok(rule, "the rule for displays under 2x");
  const covered = rule![1].split(",").map(part => part.trim().replace(/:not\(.*\)$/, ""));
  // Every hover rule that lifts something names an element the rule covers.
  const lifted: string[] = [];
  for (const file of fs.readdirSync(assets).filter(name => name.endsWith(".css") && !name.startsWith("index-") && name !== "workflow-editor.css")) {
    for (const [, selectors, body] of css(file).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/transform:\s*translate/.test(body!)) continue;
      for (const selector of selectors!.split(",").map(part => part.trim()).filter(part => part.includes(":hover"))) lifted.push(`${file}: ${selector}`);
    }
  }
  assert.ok(lifted.length >= 5, `found the lifts: ${lifted.join("; ")}`);
  for (const entry of lifted) {
    const last = entry.split(": ")[1]!.replace(/:hover.*$/, "").trim().split(/\s+/).at(-1)!;
    assert.ok(covered.some(name => name === last || (name.startsWith(".") && last.includes(name)) || (name === "button" && last === "button")),
      `${entry} lifts something the rule under 2x does not cover`);
  }
});
