export type ModuleTemplate = "empty" | "calculator";

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
        evidence = await evaluate(candidate, spec);
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
