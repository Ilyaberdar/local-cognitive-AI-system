---
title: Workflows and tasks
description: Build workflows visually, run them as tasks, and schedule them.
---

## Tasks

**Workflow → Tasks** is a board of tasks in **Todo**, **In Progress** and **Done**. Each task has a description, a workflow, a project (or its own folder) and an access mode. **Run** starts it; **Trace** shows every step.

<video controls playsinline preload="none" poster="/videos/workflow-run.jpg" aria-label="A task runs the Workflow Console Demo: the console fills live, the run waits at the review step, and Approve finishes it"><source src="/videos/workflow-run-720.mp4" type="video/mp4" media="(max-width: 900px), (pointer: coarse)" /><source src="/videos/workflow-run.mp4" type="video/mp4" /></video>

*A real run of the Workflow Console Demo from `examples/workflow-console-demo`, in real time.*

![The task board](../../../assets/screens/tasks.png)

A task without a project gets its own folder, kept across runs.

## Schedules

**Schedules** create a task every day or every week at a local time in a time zone you choose (for example `Europe/Kyiv`). Each occurrence is its own task with its own trace. If the app was off at the scheduled time, it runs once after it starts. Schedules run while the app (or the server) is running.

## Workflow editor

**Workflow → Workflow** is a visual editor: steps connected by transitions.

![The workflow editor with a run in progress](../../../assets/screens/workflow.png)

| Step | What it does |
| --- | --- |
| **Agent** | A model with tools works on the step's instructions. |
| **Files**, **Read file**, **Save** | Search, read or write files in the workspace. |
| **Search web**, **Read webpage** | Search through SearXNG or Brave, or read a page. |
| **Command** | Runs a program with its arguments, without a shell. |
| **MCP tool** | Calls one tool of an MCP server with arguments, without a model. |
| **Decision** | Checks an earlier step's output and takes one path or the other. |
| **Review** | Waits for a person: **Approve** or **Reject** on the card above the step. |
| **Terminal** | Ends the run as succeeded or failed. |

Transitions fire on a step's status (ok, failed, blocked), on an event, or on a value in its output. A step can use an earlier step's output as `{{nodes.<step-id>.data.<key>}}`.

## Runs

- A run keeps a snapshot of its workflow, so edits don't change it.
- The console shows each step's output, and **Agent activity** shows what the models did.
- Writes and commands follow the task's access mode; a step can ask for review even with full access.
- If the app restarts during a run, the run is marked interrupted and continues with **Resume**. A command whose effect is uncertain is never repeated on its own.
