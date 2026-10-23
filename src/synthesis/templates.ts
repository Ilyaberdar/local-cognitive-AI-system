export type ModuleTemplate = "empty" | "calculator" | "rate-limiter" | "repository-review";
export interface ModuleFiles { spec: string; flow: string; tests?: Record<string, string> }

/** A module on rails: a TypeScript contract checked by its shape, its dependencies, a forbidden
 * clock and the engineer's own tests, which the model reads but never writes. */
export function rateLimiterTemplate(name = "RateLimiter"): ModuleFiles {
  return {
    spec: `module ${name} version "1" {
    target { language = TypeScript; }

    description = "A token-bucket rate limiter. src/rateLimiter.ts exports class RateLimiter with constructor(options: { capacity: number; refillPerSecond: number; now: () => number }), where now() returns milliseconds. tryAcquire(tokens = 1): boolean takes the tokens and returns true when enough are available; otherwise it returns false and takes nothing. available(): number returns the tokens available now, never more than capacity. Tokens refill continuously with the time that passed, at refillPerSecond, up to capacity; a new limiter starts full. Throw RangeError when capacity or refillPerSecond is not a positive finite number, or when tokens is not a positive integer. Time comes only from options.now(): no timers, no Date.";

    artifacts {
        file "src/rateLimiter.ts";
    }

    tests {
        // The engineer's tests, next to this contract: the model reads them, never writes them.
        file "tests/rateLimiter.test.ts";
    }

    evaluate "contract-v1" {
        hard shape = Exports("src/rateLimiter.ts", ["RateLimiter"]);
        hard dependencies = Imports("src/**", deny = ["**"]);
        hard clock = Forbid("src/**", "Date\\\\.now|new Date|setTimeout|setInterval|performance\\\\.now", message = "take the time only from options.now()");
        hard behavior = Tests("tests/rateLimiter.test.ts", timeout = 30s);
    }
}
`,
    flow: `implement ${name} using "contract-v1" {
    limit iterations 6, time 20m, cost 0usd;
    policy = "local-files-v1";

    available = await models.list(provider = "llamacpp");
    selected = models.select(available, max_size = 6GiB, prefer = "coder");
    developer = await models.load(selected);

    spec = freeze(${name}.spec);
    candidate = checkout("${name === "RateLimiter" ? "rate-limiter" : `generated/${name}`}");
    feedback = none;

    while (!accepted(candidate, spec)) {
        candidate = await developer.revise(candidate, spec, feedback, file = "src/rateLimiter.ts", format = "source");
        evidence = await evaluate(candidate, spec, keep = "best");
        verdict = verify(spec, evidence);
        checkpoint(candidate, evidence, verdict);

        if (verdict.status == Pass) {
            return accept(candidate, evidence);
        }
        if (verdict.status == Unknown) {
            return needs_review(evidence);
        }
        feedback = verdict.violations;
    }
    return unresolved();
}
`,
    tests: { "tests/rateLimiter.test.ts": `import assert from "node:assert/strict";
import test from "node:test";
import { RateLimiter } from "../src/rateLimiter.ts";

// A clock the test moves by hand: the limiter must take time only from options.now().
const clock = () => {
  let now = 0;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
};

test("starts full", () => {
  const time = clock();
  const limiter = new RateLimiter({ capacity: 5, refillPerSecond: 1, now: time.now });
  assert.equal(limiter.available(), 5);
});

test("takes tokens while they last", () => {
  const time = clock();
  const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 1, now: time.now });
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(2), true);
  assert.equal(limiter.tryAcquire(), false);
  assert.equal(limiter.available(), 0);
});

test("refills with the time that passed", () => {
  const time = clock();
  const limiter = new RateLimiter({ capacity: 4, refillPerSecond: 2, now: time.now });
  assert.equal(limiter.tryAcquire(4), true);
  time.advance(1000);
  assert.equal(limiter.available(), 2);
  time.advance(500);
  assert.equal(limiter.tryAcquire(3), true);
});

test("never holds more than its capacity", () => {
  const time = clock();
  const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 10, now: time.now });
  time.advance(60_000);
  assert.equal(limiter.available(), 2);
});

test("a refused request takes nothing", () => {
  const time = clock();
  const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 1, now: time.now });
  assert.equal(limiter.tryAcquire(5), false);
  assert.equal(limiter.available(), 3);
});

test("rejects invalid settings and requests", () => {
  const time = clock();
  assert.throws(() => new RateLimiter({ capacity: 0, refillPerSecond: 1, now: time.now }), RangeError);
  assert.throws(() => new RateLimiter({ capacity: 1, refillPerSecond: Number.NaN, now: time.now }), RangeError);
  const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 1, now: time.now });
  assert.throws(() => limiter.tryAcquire(0), RangeError);
  assert.throws(() => limiter.tryAcquire(1.5), RangeError);
});
` }
  };
}

/** Parallel agents on rails: each reviews a part of src/ and leaves a note, a lead gathers the report,
 * and the report is accepted only when every file and line it cites exists. Local by default. */
export function repositoryReviewTemplate(name = "RepositoryReview"): ModuleFiles {
  return {
    spec: `module ${name} version "1" {
    description = "A review of the sources under src/ by agents working in parallel: each agent reviews its part and leaves one note in notes/, and REPORT.md gathers their findings, each with its path:line.";

    artifacts {
        file "REPORT.md";
        files "notes/**";
    }

    evaluate "contract-v1" {
        hard grounded = Grounded("REPORT.md", min = 3);
    }
}
`,
    flow: `implement ${name} using "contract-v1" {
    limit iterations 4, time 60m, steps 20000;
    policy = "agents-v1";

    // Four agents on one local model with four slots. For cloud agents, name a provider instead,
    // such as lead = await model("deepseek-flash", provider = "deepseek"), and allow cloud models for the project.
    installed = await models.list(provider = "llamacpp");
    lead = await models.load(models.select(installed, max_size = 6GiB), slots = 4, context = 16384);

    spec = freeze(${name}.spec);
    candidate = checkout("review");

    tasks = await lead.split("Review the sources under src/ for swallowed errors, promises that are not awaited and misleading error messages. Split by files so that every file is reviewed once.", 4,
        paths = files.read("src/**"));

    agents = [];
    for (i in range(4)) {
        agents = append(agents, agent(lead, tools = [files.read("src/**"), files.write("review/notes/**")],
            instructions = "Read the files of your task. Write your findings to one note, review/notes/<a short name for your part>.md, as a Markdown list where each item starts with path:line.",
            steps = 12));
    }
    // An agent that answers in text instead of writing its note has its answer saved as one.
    results = await parallel_map(agents, tasks, concurrency = 4, answer_file = "review/notes/agent-{n}.md");
    candidate = await lead.synthesize(candidate, spec, results, file = "REPORT.md");

    // The report is checked, and written again with the exact problems until it holds.
    while (!accepted(candidate, spec)) {
        evidence = await evaluate(candidate, spec);
        verdict = verify(spec, evidence);
        if (verdict.status == Pass) {
            return accept(candidate, evidence);
        }
        if (verdict.status == Unknown) {
            return needs_review(evidence);
        }
        candidate = await lead.synthesize(candidate, spec, results, file = "REPORT.md", feedback = verdict.violations);
    }
    return unresolved();
}
`
  };
}
export function emptyModuleTemplate(name: string): {spec: string; flow: string} {
  return {
    spec: `module ${name} version "1" {
    description = "Describe the responsibility and observable behavior of ${name}.";

    artifacts {
        // Replace this placeholder with the files your module should produce.
        file "module.txt";
    }

    evaluate "${name}-v1" {
        // Register a trusted evaluator in the application before acceptance.
        // An unknown evaluator never produces Pass.
        hard contract = Pass("configure-evaluator");
    }
}
`,
    flow: `implement ${name} using "${name}-v1" {
    limit iterations 6, time 15m, cost 0usd;
    policy = "local-files-v1";

    spec = freeze(${name}.spec);
    candidate = checkout("generated/${name}");

    // Add model selection, roles, revisions, and trusted evaluation here.
    // This starter deliberately does not load a model or accept a candidate.
    return unresolved();
}
`
  };
}

export function calculatorTemplate(name = "Calculator", mode: "focused" | "compact" = "focused"): {spec: string; flow: string} {
  const revisions = mode === "compact" ? "        candidate = await developer.revise(candidate, spec, feedback);" : `        candidate = await developer.revise(candidate, spec, feedback,
            file = "calculator.js", format = "source",
            instruction = "Write a global calculate(a,b,operation) function with numeric + - * / and throw Error on division by zero. Then wire #calculate click: convert #a.value and #b.value using Number, call calculate, display numeric answer in #result.textContent; catch errors and display Error. Wire #clear click to empty both input values and result text. Do not name a button variable calculate because that would shadow the function. No other behavior is needed.");
        candidate = await developer.revise(candidate, spec, feedback,
            file = "index.html", format = "source",
            instruction = "Write complete HTML with title Calculator. Head links style.css using link rel=stylesheet. Body has label/input type=number id=a, label/input type=number id=b, labeled select id=operation with option values + - * /, button id=calculate, button id=clear, output id=result. End body with exactly one script src=calculator.js. No inline JavaScript, no other scripts. Do not omit the second input or any label.");
        candidate = await developer.revise(candidate, spec, feedback,
            file = "style.css", format = "source",
            instruction = "Write only a tiny dark CSS stylesheet: dark body background, light text, centered main content, spaced labeled inputs, select, buttons and visible result. Use at most 12 rules. No JavaScript, no HTML, no imports, no url resources. Stop after the last closing brace.");`;
  return {
    spec: `module ${name} version "1" {
    target { language = JavaScript; }

    description = "Build a compact dark calculator web UI using plain HTML/CSS/JavaScript. calculator.js must define a global function calculate(a, b, operation), taking numeric operands and '+', '-', '*', '/' and returning the numeric answer; division by zero must throw Error. index.html must contain labeled number inputs id=a and id=b, select id=operation with + - * / options, button id=calculate, output id=result, button id=clear. Clicking calculate shows the answer or Error in result; clear resets both inputs and result to empty. Load style.css and a classic calculator.js script at the end of body, after all controls, without async/defer. Wire clicks using addEventListener or onclick. No network, dependencies, inline event attributes, dynamic evaluation or modules. Both calculator.js and inline script blocks at the end of body may wire events. Keep the implementation simple and accessible.";

    artifacts {
        file "calculator.js";
        file "index.html";
        file "style.css";
    }

    evaluate "calculator-v1" {
        hard arithmetic = Pass("calculator-arithmetic-v1");
        hard ui = Pass("calculator-ui-v1");
    }
}
`,
    flow: `implement ${name} using "calculator-v1" {
    limit iterations 6, time 15m, cost 0usd;
    policy = "local-files-v1";

    available = await models.list(provider = "llamacpp");
    selected = models.select(available, max_size = ${mode === "focused" ? "6GiB" : "2GiB"}, prefer = "${mode === "focused" ? "qwen2.5-7b" : "qwen2.5-1.5b"}");
    developer = await models.load(selected);

    spec = freeze(${name}.spec);
    candidate = checkout("${name === "Calculator" ? "calculator" : `generated/${name}`}");
    feedback = none;

    while (!accepted(candidate, spec)) {
${revisions}
        evidence = await evaluate(candidate, spec, keep = "best");
        verdict = verify(spec, evidence);
        checkpoint(candidate, evidence, verdict);

        if (verdict.status == Pass) {
            return accept(candidate, evidence);
        }
        if (verdict.status == Unknown) {
            return needs_review(evidence);
        }
        feedback = verdict.violations;
    }
    return unresolved();
}
`
  };
}
