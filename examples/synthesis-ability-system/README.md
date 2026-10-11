# Ability system on rails (C++)

An engine-agnostic ability system core in the spirit of Unreal's Gameplay Ability System, written by a local model against an engineer's contract.

The engineer owns three things, and the model owns one file:

| File | Written by | What it is |
| --- | --- | --- |
| `ability-system/include/AbilitySystem.h` | engineer, frozen | The interface. The model reads it and may not change it. |
| `Synthesis/AbilitySystem/AbilitySystem.lcspec` | engineer | The contract: the behavior in words, and the gates that decide acceptance. |
| `Synthesis/AbilitySystem/tests/ability_system_test.cpp` | engineer | Nine tests the module must pass. The model reads them and never writes them. |
| `ability-system/src/AbilitySystem.cpp` | model | The implementation. |

The contract's gates:

- `Exports`: the implementation defines `AbilitySystem::TryActivate`, `Grant`, `CooldownRemaining`, `ApplyDamage` and `RestoreMana`.
- `Imports`: `src/` includes only `AbilitySystem.h` and standard headers, and none of `<thread>`, `<random>`, `<chrono>`, `<ctime>`, `<iostream>` or `<fstream>`.
- `Forbid`: no `rand`, `time`, `printf`, `std::cout` or `std::chrono` in the code (comments and strings don't count). The core takes time from the caller, so it stays deterministic.
- `Tests`: the engineer's tests, built with `-fsanitize=address,undefined` and run in a sandbox.

Each failed gate goes back to the model as short, exact items, for example `behavior: cooldown_blocks_until_it_elapses: LC_CHECK(caster.TryActivate("Fireball", target, 12.0) == ActivationResult::OnCooldown) failed [tests/ability_system_test.cpp:41]`.

## Run it

1. Copy `ability-system/` and `Synthesis/` into a project folder.
2. Open the project in Local Cognitive → Synthesis, select `AbilitySystem` and press Run.

It needs a C++ compiler (Xcode Command Line Tools on a Mac; `clang++` or `g++` on Linux, for example `sudo dnf install gcc-c++` or `sudo apt install g++` on a server) and a sandbox: built into macOS; [bubblewrap](https://github.com/containers/bubblewrap) on Linux, which a Local Cognitive server sets up. A model of 7B or more for code works best; the flow prefers one with "coder" in its name.

`reference/AbilitySystem.cpp` is a hand-written implementation that passes every gate: the baseline to compare the models' output with. It is not part of a run.
