---
title: Synthesis
description: Write a module's contract and an agent flow, and get code that is checked against the contract.
---

Synthesis turns a description of a module into working code with agents, and checks the result against what you described.

![The Synthesis workspace](../../../assets/screens/synthesis.png)

A Synthesis module has two files in your project:

- **`.lcspec`, the contract:** what the module must do, its files, and the checks that decide whether it is done.
- **`.lcflow`, the flow:** which models do the work, how many iterations, time and cost they may use, and how they react to failed checks.

**Run synthesis** runs the flow: agents write the files, the checks run, failures go back to the agents, and the run ends **Accepted** when every check passes, or stops at its limits. Every iteration, check and decision stays in the run history. You edit the files in your own editor (**Open in editor**) and **Refresh** to validate them.

## Contracts on rails

Synthesis is built to keep small local models on the architecture you designed. In the contract you decide:

- **The interface.** A `frozen` file, such as a C++ header, is yours: the model implements it and may not change it.
- **The behavior.** Your own tests, next to the contract, run against every candidate in a sandbox. The model reads them, never writes them; `hidden = true` keeps a holdout set sealed.
- **The architecture.** `Exports` checks the public shape, `Imports` what may depend on what (for example, no `<thread>` in a game core, or no `node:fs` in a domain layer), and `Forbid` what the code may not use, such as a clock or randomness the caller should inject.

Each failure goes back to the model as an exact item, for example a failed test with its expected and actual values and its file and line, until every gate passes.

Tests run in TypeScript or JavaScript (Node.js 22.18+), Python 3 and C++20. The sandbox is built into macOS; on Linux it needs [bubblewrap](https://github.com/containers/bubblewrap). Windows has no sandbox yet, so tests don't run there.

To start, choose **New module → Rate limiter (TypeScript, with tests)**. For C++, the [ability system example](https://github.com/Ilyaberdar/local-cognitive-AI-system/tree/main/examples/synthesis-ability-system) builds an engine-agnostic core in the spirit of Unreal's Gameplay Ability System against a frozen header.

The [Synthesis language](/guides/synthesis-language/) page is the full reference: syntax, runtime functions, model roles, a complete example and the current limits.
