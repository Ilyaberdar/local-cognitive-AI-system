---
title: Synthesis
description: Write a module's contract and an agent flow, and get code that is checked against the contract, from one local model or many agents in parallel, local or in the cloud.
---

Synthesis turns a description of a module into working code with agents, and checks the result against what you described.

<video controls playsinline preload="none" poster="https://local-cognitive.com/media/docs/synthesis-v1.jpg" aria-label="Synthesis: the Rate limiter contract, Run synthesis, the real tests passing, and the verified patch applied"><source src="https://local-cognitive.com/media/docs/synthesis-720-v1.mp4" type="video/mp4" media="(max-width: 900px), (pointer: coarse)" /><source src="https://local-cognitive.com/media/docs/synthesis-v1.mp4" type="video/mp4" /></video>

*A real run of the Rate limiter module on Qwen3.8 27B, accepted on its first iteration. 61 s of loading and writing are sped up 10×, and the video marks it.*

![The Synthesis workspace](../../../assets/screens/synthesis.png)

A Synthesis module has two files in your project:

- **`.lcspec`, the contract:** what the module must do, its files, and the checks that decide whether it is done.
- **`.lcflow`, the flow:** which models do the work, how many iterations, time and cost they may use, and how they react to failed checks.

**Run synthesis** runs the flow: agents write the files, the checks run, failures go back to the agents, and the run ends **Accepted** when every check passes, or stops at its limits. Every iteration, check and decision stays in the run history. You edit the files in your own editor (**Open in editor**) and **Refresh** to validate them.

Nothing in your project changes during a run. **Changes** lists each file the run would add, modify or delete; choose one to see its diff, its source with line numbers, or, for Markdown and JSON, the file formatted. In a report, every `path:line` it cites opens that place: a file of the run at the line, or the project's file, read-only. The places `Grounded` found missing are marked in red. **Apply verified patch** writes the files all at once, after checking that none of them changed in the meantime.

Nothing a model wrote runs in the app: Markdown is shown without its HTML, links leave the app only for the web, and an HTML page is shown as its source.

## Contracts on rails

Synthesis is built to keep small local models on the architecture you designed. In the contract you decide:

- **The interface.** A `frozen` file, such as a C++ header, is yours: the model implements it and may not change it.
- **The behavior.** Your own tests, next to the contract, run against every candidate in a sandbox. The model reads them, never writes them; `hidden = true` keeps a holdout set sealed.
- **The architecture.** `Exports` checks the public shape, `Imports` what may depend on what (for example, no `<thread>` in a game core, or no `node:fs` in a domain layer), and `Forbid` what the code may not use, such as a clock or randomness the caller should inject.

Each failure goes back to the model as an exact item, for example a failed test with its expected and actual values and its file and line, until every gate passes.

Tests run in TypeScript or JavaScript (Node.js 22.18+), Python 3 and C++20. The sandbox is built into macOS; on Linux it needs [bubblewrap](https://github.com/containers/bubblewrap), which the server installer sets up from 0.1.3 (on a server installed earlier, run `sudo local-cognitive-server sandbox` once after updating). Windows has no sandbox yet, so tests don't run there.

## Cloud models

A flow can use any provider set up in **Settings → Models & Providers**, next to your local models: OpenAI, Claude, Gemini, Qwen, DeepSeek, OpenRouter, Groq, Perplexity and others. Declare `policy = "cloud-files-v1";` and name the provider in the flow:

```lcflow
developer = await model("deepseek-flash", provider = "deepseek");
```

Local and cloud models can work in one flow, for example a cloud developer and a local reviewer.

A cloud model receives the contract's description, the frozen files, the visible tests, the candidate's files and whatever the flow gives it to read. Hidden tests never leave your computer. So a project sends nothing to the cloud until you allow it: switch on **Cloud models** at the bottom of the Synthesis workspace. The switch belongs to each project, and only the computer that owns the project can set it. For a project on your GPU server, the server's owner allows it there with `sudo local-cognitive-server cloud-models allow <project>`; your computer shows **Cloud models: on** or **off**.

Before you run, the module lists what Run would refuse: a provider that isn't set up or has no key, or a cloud provider in a project that doesn't allow cloud models. The run checks again before every call, so switching **Cloud models** off stops the next request.

The run's **Models** panel shows each model with its provider, and the run's model calls and tokens. The flow's `cost` limit is recorded but doesn't stop a run yet: watch your spending in the provider's own dashboard.

## Agents in parallel

With `policy = "agents-v1"` a flow makes agents: models that read, search and change files themselves, in a loop of actions, until they answer. `parallel_map` runs them in parallel, up to 64 at once and 1,000 tasks a run. A lead model can split a goal into tasks (`split`) and write one file from the agents' results (`synthesize`).

```lcflow
tasks = await lead.split("Review error handling in src/.", 20,
    paths = files.read("src/**"));
agents = [];
for (i in range(20)) {
    reviewer = agent(provider = "deepseek", model = "deepseek-flash",
        tools = [files.read("src/**"), files.write("review/notes/**")]);
    agents = append(agents, reviewer);
}
results = await parallel_map(agents, tasks, concurrency = 20);
candidate = await lead.synthesize(candidate, spec, results,
    file = "REPORT.md");
```

- **Rights by path.** Each agent reads, writes and deletes only what its `files.read`, `files.write` and `files.delete` patterns name. No agent reads a contract or its tests, whatever its patterns say.
- **Writes go into the run.** Agents change only the run's candidate: the contract's files and its areas, such as `files "notes/**"` for one note per agent. Your project changes on **Apply verified patch**, deletions included.
- **One version for everyone.** Every agent reads a project file as the run first read it, so editing the project during a run never gives two agents different versions.
- **No surprises.** Agents use no plugins or MCP servers and ask for no approval. A refused action is final, and the agent is told why.
- **Local agents** share one loaded model through its slots: `models.load(selected, slots = 6, context = 16384)` answers six agents at once. See [Models](/guides/models/#slots-for-parallel-agents).
- **Cloud agents** need the project's **Cloud models** switch. When a provider answers that it is rate-limited, the run sends it fewer requests at once and repeats the refused one after a pause, without spending the agent's turns. An agent's request may take up to 10 minutes, so a slow model's long answer isn't cut off.

The run's **Agents** tab counts the agents that are queued, running, done and failed. The agents are listed on the left, one per task, with the model, steps, tokens, time, the files each wrote and its error; the chosen agent's steps are on the right, each action with its result or refusal, and the answer. The first agent that failed is shown until you choose another.

*Checked live: 20 DeepSeek agents reviewed a folder of this app's code in 5 minutes. 18 of them finished and wrote 15 notes, and the lead's report passed the contract.*

### Agents that share files

- **Owned files.** With `files.write("notes/**", own = true)`, each file belongs to the agent that first creates or changes it; the others read it and change nothing of it.
- **Checkouts, as in Perforce.** An agent checks out the files it works on, all of them or none. Until it submits, reverts or finishes, its changes stay its own, and the others read the last submitted version and change nothing of those files. A finished agent's checkout is submitted; a failed one's is dropped. `parallel_map(..., checkout = "required")` makes every change need a checkout.
- **Waiting.** An agent may wait up to 10 minutes for a file another one holds, and only while it holds nothing itself, so two agents never wait on each other.
- Without either, two agents that change one file meet a version conflict: the second reads the file again and redoes its change.

### A report that cites real code

The `Grounded("REPORT.md", min = 5)` gate checks that every file and every `path:line` a report cites exists, in the project as Apply would leave it. What fails goes back to the lead as exact items, for example `REPORT.md:14 cites src/a.ts:300, but src/a.ts has 120 lines`, and `synthesize(..., feedback = verdict.violations)` writes the report again. `Grounded` checks references, not whether each claim is true: read the report.

### The agents' terminal

With `terminal(allow = ["node", "npm"])` among its tools, an agent can build and run tests as it works, and fix what fails before it answers. It can run `node`, `npm`, `npx`, `python3`, `git`, `rg`, `ls` and `cat`:

- in the same sandbox as contract tests: no network, and nothing of your home folder, other temporary folders or the app's data;
- in a copy of the files it may read, with its own changes, refreshed before each command; contracts and their tests are never in it;
- for at most 120 s a command; `git` only reads history, and `npm` only runs `test`, `run` and `ls`;
- what a command writes stays in the copy: the run's files change only through the agent's file actions.

Before a run gives agents a terminal, the sandbox shows that it isolates. A process inside it tries to read a file outside its folders, write outside its work folder and reach a local port. If any of these succeeds, the run stops and says why, and contract tests are Unknown for the same reason. Windows has no sandbox yet, so a terminal is refused there.

*Checked live: three DeepSeek agents each fixed a bug, running the module's tests in their terminal until they passed. The run was accepted in about 15 s.*

## Start a module

Choose **New module**:

- **Rate limiter (TypeScript, with tests):** one model writes a module against your tests and architecture gates.
- **Repository review (parallel agents):** four agents on one local model with four slots review `src/`, each leaving a note, and a lead writes `REPORT.md`, accepted when every file and line it cites exists. The flow says how to switch to a cloud provider for more agents.

For C++, the [ability system example](https://github.com/Ilyaberdar/local-cognitive-AI-system/tree/main/examples/synthesis-ability-system) builds an engine-agnostic core in the spirit of Unreal's Gameplay Ability System against a frozen header.

The [Synthesis language](/guides/synthesis-language/) page is the full reference: syntax, runtime functions, model roles, agents, complete examples and the current limits.
