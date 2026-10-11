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

The [Synthesis language](/guides/synthesis-language/) page is the full reference: syntax, runtime functions, model roles, a complete example and the current limits.
