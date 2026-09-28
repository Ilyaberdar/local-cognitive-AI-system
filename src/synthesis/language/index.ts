import { parseFlow, parseSpec } from "./Parser";
import { analyzeFlow, analyzeSpec } from "./semanticAnalyzer";
import { CompiledProgram, CompileOptions } from "./types";

export * from "./types";
export { lex } from "./Lexer";
export { parseFlow, parseSpec } from "./Parser";
export { analyzeFlow, analyzeSpec, callName } from "./semanticAnalyzer";

/** Compile authored source into a typed, source-mapped interpreter program. */
export function compileProgram(specSource: string, flowSource: string, options: CompileOptions = {}): CompiledProgram {
  const spec = parseSpec(specSource, options.specPath);
  const flow = parseFlow(flowSource, options.flowPath);
  const diagnostics = [...spec.diagnostics, ...flow.diagnostics];
  if (spec.ast && !spec.diagnostics.some((item) => item.severity === "error")) diagnostics.push(...analyzeSpec(spec.ast, options));
  if (flow.ast && !flow.diagnostics.some((item) => item.severity === "error")) diagnostics.push(...analyzeFlow(flow.ast, spec.ast, options));
  return { spec: spec.ast, flow: flow.ast, diagnostics };
}
