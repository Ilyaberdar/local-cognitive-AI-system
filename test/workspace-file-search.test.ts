import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { parseAgentAction } from "../src/tools/AgentTool";
import { WorkspaceFileService } from "../src/tools/WorkspaceFileService";
import { WorkspaceSnapshot } from "../src/workspace/types";

async function fixture(t: TestContext, files: Record<string, string>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lcai-file-search-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content);
  }
  const workspace: WorkspaceSnapshot = { version: 1, kind: "project", rootPath: root,
    outputDir: root, allowedDirectories: [root], memoryScope: "file-search-test" };
  const service = new WorkspaceFileService();
  const search = async (args: Record<string, unknown>) => {
    const action = await service.prepare(parseAgentAction({ tool: "file.search", arguments: { query: "plugin", ...args } }), workspace);
    const result = await service.execute(action, workspace);
    assert.equal(result.ok, true);
    return JSON.parse(result.output) as { scannedFiles: number; truncated: boolean; matches: Array<{ path: string; absolutePath: string; line?: number; text?: string }> };
  };
  return Object.assign(search, { root, read: async (filePath: string) => {
    const action = await service.prepare(parseAgentAction({ tool: "file.read", arguments: { path: filePath } }), workspace);
    const result = await service.execute(action, workspace);
    assert.equal(result.ok, true);
    return JSON.parse(result.output) as { content: string; version: string };
  } });
}

test("recursive file.search filename includes find source evidence from project and source roots", async t => {
  const search = await fixture(t, {
    "package-lock.json": "plugin dependency",
    "src/index.ts": "export const plugin = true;",
    "src/plugins/PluginRegistry.ts": "// registered plugin\nexport class PluginRegistry {}",
    "src/ui/PluginPicker.tsx": "// plugin picker",
    "src/docs/plugins.md": "plugin documentation",
    "src/assets/logo.svg": "plugin logo"
  });
  const include = ["*.ts", "*.tsx", "*.js", "*.json", "*.md"];
  const scoped = await search({ path: "src", include });
  assert.deepEqual([...new Set(scoped.matches.map(item => item.path))].sort(),
    ["docs/plugins.md", "index.ts", "plugins/PluginRegistry.ts", "ui/PluginPicker.tsx"]);
  assert.equal(scoped.scannedFiles, 5);
  assert.equal(scoped.truncated, false);
  assert.ok(scoped.matches.some(item => item.path === "plugins/PluginRegistry.ts" && item.line === 1 && item.text === "// registered plugin"));
  const project = await search({ path: ".", include });
  assert.ok(project.matches.some(item => item.path === "src/plugins/PluginRegistry.ts"));
});

test("file.search preserves root-relative and recursive directory glob semantics", async t => {
  const search = await fixture(t, {
    "top.ts": "plugin top",
    "src/direct.ts": "plugin direct",
    "src/deep/nested.ts": "plugin nested",
    "other/src/other.ts": "plugin other"
  });
  const paths = async (include: string[]) => (await search({ include })).matches.map(item => item.path).sort();
  assert.deepEqual(await paths(["src/*.ts"]), ["src/direct.ts"]);
  assert.deepEqual(await paths(["src/**/*.ts"]), ["src/deep/nested.ts", "src/direct.ts"]);
  assert.deepEqual(await paths(["./*.ts"]), ["top.ts"]);
  assert.deepEqual(await paths(["**/*.ts"]), ["other/src/other.ts", "src/deep/nested.ts", "src/direct.ts", "top.ts"]);
});

test("file.search applies filename exclusions recursively and prunes excluded directories", async t => {
  const search = await fixture(t, {
    "src/keep.ts": "plugin keep",
    "src/keep.test.ts": "plugin test",
    "src/deep/nested.test.ts": "plugin nested test",
    "src/generated/schema.ts": "plugin generated",
    "generated/root.ts": "plugin generated root",
    "node_modules/ignored.ts": "plugin dependency"
  });
  const result = await search({ include: ["*.ts"], exclude: ["*.test.ts", "generated"] });
  assert.deepEqual(result.matches.map(item => item.path), ["src/keep.ts"]);
  assert.equal(result.scannedFiles, 1);
});

test("file.search keeps traversal bounded even if includes match no files", async t => {
  const search = await fixture(t, {
    "a.json": "plugin irrelevant",
    "b.md": "plugin irrelevant",
    "src/answer.ts": "plugin evidence"
  });
  const result = await search({ include: ["*.ts"], maxFiles: 1 });
  assert.equal(result.scannedFiles, 1);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.matches, []);
});

test("search matches from a nested root can be read using their absolutePath without rebasing", async t => {
  const search = await fixture(t, {
    "src/app/buildRuntime.ts": "import { PluginLoader } from '../plugins/PluginLoader';"
  });
  const result = await search({ path: "src", query: "PluginLoader" });
  assert.equal(result.matches.length, 1);
  const match = result.matches[0];
  assert.equal(match.path, "app/buildRuntime.ts", "Existing relative paths remain relative to the search root.");
  assert.equal(match.absolutePath, path.join(search.root, "src/app/buildRuntime.ts"));
  const read = await search.read(match.absolutePath);
  assert.equal(read.content, "1: import { PluginLoader } from '../plugins/PluginLoader';");
  assert.match(read.version, /^[a-f0-9]{64}$/);
});

test("empty-query search returns readable absolute paths and excludes symlinks outside the workspace", async t => {
  const search = await fixture(t, { "src/plugins/loader.ts": "plugin implementation" });
  const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lcai-search-outside-")));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, "secret.ts"), "outside workspace");
  await fs.symlink(outside, path.join(search.root, "src/external"), "dir");
  await fs.symlink(path.join(outside, "secret.ts"), path.join(search.root, "src/secret.ts"));
  const result = await search({ path: "src", query: "", include: ["*.ts"] });
  assert.deepEqual(result.matches.map(match => match.path), ["plugins/loader.ts"]);
  for (const match of result.matches) {
    assert.equal(path.isAbsolute(match.absolutePath), true);
    assert.equal(await fs.realpath(match.absolutePath), path.join(search.root, "src", match.path));
    assert.equal((await search.read(match.absolutePath)).content, "1: plugin implementation");
  }
});

test("a path a model ran on into prose is refused with a short reason, before the file system sees it", () => {
  const prose = `notes/README.md}}}\n\nThe workspace has no story yet, so the next step is to search for one. ${"x".repeat(300)}`;
  assert.throws(() => parseAgentAction({ tool: "file.read", arguments: { path: prose } }), (error: Error) => /one line naming a file or folder/.test(error.message) && !error.message.includes("The workspace has no story"));
  assert.throws(() => parseAgentAction({ tool: "file.write", arguments: { path: `${"long".repeat(70)}.md`, content: "x", expectedVersion: "missing" } }),
    (error: Error) => /at most 255 bytes/.test(error.message));
  assert.equal(parseAgentAction({ tool: "file.read", arguments: { path: "notes/README.md" } }).arguments.path, "notes/README.md");
});
