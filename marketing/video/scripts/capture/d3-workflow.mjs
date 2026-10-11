// D3: a task runs the Workflow Console Demo; the console fills live, the run waits at the review
// step, Approve finishes it. No model and no network.
//
// Setup (disclosed in handoff/shot-list.md): a fresh profile, then the example's project, workflow
// and task are created through the app's own API, as examples/workflow-console-demo/README.md
// describes. The project folder is /Users/Shared/Demo/workflow-console-demo, a path without a user
// name, because the console prints the saved file's absolute path.
//
//   node scripts/capture/d3-workflow.mjs
import fs from "node:fs";
import path from "node:path";
import { appRoot, launchApp, project } from "./app.mjs";
import { startShot } from "./recorder.mjs";

const shotId = "D3-workflow";
const demoFolder = "/Users/Shared/Demo/workflow-console-demo";
const example = path.join(appRoot, "examples", "workflow-console-demo");
const workflow = JSON.parse(fs.readFileSync(path.join(example, "workflow.json"), "utf8"));
const task = JSON.parse(fs.readFileSync(path.join(example, "task.json"), "utf8"));

fs.rmSync(path.join(project, ".profiles", shotId), { recursive: true, force: true });
fs.rmSync(demoFolder, { recursive: true, force: true });
fs.mkdirSync(demoFolder, { recursive: true });

const { app, page } = await launchApp({ profile: shotId, theme: "light", fontScale: 115 });
try {
  const ids = await page.evaluate(async ({ rootPath, workflow, task }) => {
    const post = async (url, body) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Local-Cognitive": "1" },
        body: JSON.stringify(body),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status} ${json?.message ?? json?.error ?? ""}`);
      return json;
    };
    const created = await post("/projects", { name: "Workflow Console Demo", rootPath });
    await post("/workflows", workflow);
    const createdTask = await post("/tasks", { ...task, projectId: created.id });
    return { projectId: created.id, taskId: createdTask.id };
  }, { rootPath: demoFolder, workflow, task });
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1500);

  const shot = await startShot({ app, page, shotId });
  await shot.park(0.5, 0.42, 500);
  await shot.pause(1200);

  await shot.click(page.locator('button[data-action="route"][data-route="orchestration"]'), "open Workflow");
  const card = page.locator(`article.task-card[data-task-id="${ids.taskId}"]`);
  await card.waitFor({ state: "visible" });
  await shot.pause(600);
  await shot.hover(card.locator("h3"), "the task card", { moveMs: 800 });
  await shot.pause(1400);

  await shot.click(card.locator('button[data-action="run-task"]'), "Run the task");
  await page.locator(".fsm-editor--run").waitFor({ state: "visible", timeout: 15000 });
  shot.log("run view open");
  await shot.park(0.73, 0.5, 700);

  const output = page.locator(".workflow-console__output .workflow-log-row.is-output pre");
  await output.filter({ hasText: "[1/3]" }).first().waitFor({ timeout: 15000 });
  shot.log("stdout 1/3");
  await output.filter({ hasText: "WORKFLOW-CONSOLE-DEMO-OK" }).first().waitFor({ timeout: 15000 });
  shot.log("file content");
  await page.locator(".workflow-console__output .workflow-log-row.is-output.level-warning").first().waitFor({ timeout: 15000 });
  shot.log("stderr line");
  await output.filter({ hasText: "[3/3]" }).first().waitFor({ timeout: 15000 });
  shot.log("stdout 3/3");

  const approve = page.locator('section.fsm-approval[aria-label="Approval for Review the console"] button.fsm-approval__approve');
  await approve.waitFor({ state: "visible", timeout: 15000 });
  shot.log("waiting for review");
  await shot.pause(1800);
  await shot.click(approve, "Approve");

  await page.locator(".workflow-console__summary .workflow-run-status.status-done").waitFor({ timeout: 15000 });
  shot.log("run done");
  await shot.park(0.73, 0.31, 900);
  await shot.pause(3000);
  const record = await shot.stop();

  const written = fs.readFileSync(path.join(demoFolder, "demo-output.txt"), "utf8");
  console.log(JSON.stringify({ ...record, steps: record.steps.map(s => `${s.step}@${s.ms}`), demoOutputOk: written.includes("WORKFLOW-CONSOLE-DEMO-OK") }));
} finally {
  await app.close();
}
