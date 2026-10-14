import type { LLMService } from "../../llm/LLMService";
import { LLMResponse, ManagedModel, TokenUsage } from "../../types";
import { filePattern } from "../language/semanticAnalyzer";
import { SynthesisError } from "../types";
import type { TaskResult } from "./AgentPool";
import { TERMINAL_COMMANDS } from "./Terminal";

type Llm = Pick<LLMService, "generateObject" | "generateText"> & Partial<Pick<LLMService, "getContextWindow">>;
export interface Permission { kind: "permission"; access: "read" | "write" | "delete" | "terminal"; patterns: string[]; own?: boolean }
export const MAX_TASK_CHARS = 8000;

/** files.read(...), files.write(...), files.delete(...): project-relative patterns. */
export function permission(access: Permission["access"], patterns: unknown[], own?: unknown): Permission {
  if (own !== undefined && (typeof own !== "boolean" || access !== "write")) throw new SynthesisError("own = true is for files.write: the files an agent creates or changes there are its own.");
  if (!patterns.length || patterns.length > 12) throw new SynthesisError(`files.${access} takes 1 to 12 patterns.`);
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || !filePattern(pattern)) throw new SynthesisError(`files.${access}: ${String(pattern)} is not a project-relative pattern such as "src/**".`);
  }
  return Object.freeze({ kind: "permission", access, patterns: Object.freeze([...patterns as string[]]) as string[], ...(own ? { own: true } : {}) });
}

/** terminal(allow = [...]): the commands an agent's sandboxed terminal may run; all of them without allow. */
export function terminalPermission(allow?: unknown): Permission {
  const commands = allow === undefined ? [...TERMINAL_COMMANDS] : allow;
  if (!Array.isArray(commands) || !commands.length || commands.some(command => !(TERMINAL_COMMANDS as readonly unknown[]).includes(command))) {
    throw new SynthesisError(`terminal(allow = [...]) names commands of ${TERMINAL_COMMANDS.join(", ")}.`);
  }
  return Object.freeze({ kind: "permission", access: "terminal", patterns: Object.freeze([...new Set(commands as string[])]) as string[] });
}
/** How many characters of prompt a model takes, leaving room for its answer (and its thinking). A cloud
 * model whose window is not known is taken to have the 128k tokens current ones have; a local one 8k. */
function promptBudget(llm: Llm, model: ManagedModel): number {
  const window = llm.getContextWindow?.(model.providerId, model.id) ?? (model.providerId === "llamacpp" ? 8192 : 128_000);
  return Number.isFinite(window) ? Math.max(6000, Math.min(300_000, Math.floor((window - Math.min(36_000, window / 3)) * 2.5))) : 60_000;
}
/** A split or a report may take a thinking model minutes: longer than a chat's default timeout. */
const LONG_REQUEST_MS = 600_000;
/** The answer's room: thinking models spend much of it reasoning before they write. */
const OUTPUT_TOKENS = 32_000;

/** A goal split by a model into `count` independent tasks, one per agent. */
export async function splitGoal(llm: Llm, model: ManagedModel, request: { goal: string; count: number; module: string; description: string; context?: string; paths?: string[];
  instruction?: string; signal: AbortSignal; spent(usage?: TokenUsage): void }): Promise<string[]> {
  const { goal, count } = request;
  if (!goal.trim() || goal.length > MAX_TASK_CHARS) throw new SynthesisError(`split takes a goal of 1 to ${MAX_TASK_CHARS} characters.`);
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new SynthesisError("split makes 1 to 1,000 tasks.");
  const budget = promptBudget(llm, model);
  const paths = request.paths?.length ? `Files the agents can read (${request.paths.length}${request.paths.length >= 400 ? ", the first 400" : ""}):\n${request.paths.join("\n")}`.slice(0, Math.floor(budget / 3)) : "";
  const prompt = [
    `Split this goal into exactly ${count} tasks, one for each of ${count} agents that work at the same time and cannot talk to each other.`,
    "Each task is self-contained: it names the files or folders it covers and what its agent returns. Tasks do not overlap, and together they cover the goal.",
    `Goal: ${goal}`,
    `Module ${request.module}: ${request.description}`.slice(0, 4000),
    request.instruction ? `How to split: ${request.instruction}` : "",
    paths,
    request.context ? `Context:\n${request.context}`.slice(0, Math.floor(budget / 3)) : "",
    `Return JSON only: {"tasks": ["first task", "second task", ...]} with exactly ${count} strings.`
  ].filter(Boolean).join("\n\n");
  // Room for a thinking model's reasoning as well as the list itself.
  const { data, response } = await llm.generateObject<{ tasks?: unknown }>({ usagePurpose: "synthesis", model: model.id, signal: request.signal, prompt, maxTokens: OUTPUT_TOKENS, timeoutMs: LONG_REQUEST_MS,
    systemPrompt: "You plan work for parallel agents. Output only the JSON object.", localReasoningBudget: 0,
    responseFormat: { type: "json_schema", name: "tasks", strict: true, schema: { type: "object", properties: { tasks: { type: "array", items: { type: "string" } } }, required: ["tasks"], additionalProperties: false } } },
    model.providerId);
  request.spent(response.usage);
  const parsed = data?.tasks ?? fromText(response);
  const tasks = (Array.isArray(parsed) ? parsed : []).filter((task): task is string => typeof task === "string" && !!task.trim()).map(task => task.trim().slice(0, MAX_TASK_CHARS)).slice(0, count);
  if (!tasks.length) throw new SynthesisError(`${model.id} returned no tasks${response.error ? `: ${response.error}` : "."}`);
  return tasks;
}
/** A JSON answer some providers wrap in prose or a fence. */
function fromText(response: LLMResponse): unknown {
  const text = response.text ?? "";
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try { return (JSON.parse(text.slice(start, end + 1)) as { tasks?: unknown }).tasks; } catch { return undefined; }
}

const findingsOf = (result: TaskResult) => `### Agent ${result.index + 1}${result.ok ? "" : " (failed)"}\nTask: ${result.task.slice(0, 600)}\n\n${result.ok ? result.output : `Failed: ${result.error}`}` +
  (result.files.length ? `\nFiles it wrote: ${result.files.join(", ")}` : "");

/** The agents' results gathered into one file's text. Results that do not fit the model's prompt are
 * first merged in groups (and the merges again), so a thousand results end in one answer. */
export async function synthesizeResults(llm: Llm, model: ManagedModel, request: { results: TaskResult[]; file: string; module: string; description: string; instruction?: string; feedback?: string[]; current?: string; signal: AbortSignal;
  progress?: (message: string) => Promise<void>; spent(usage?: TokenUsage): void }): Promise<string> {
  const budget = promptBudget(llm, model);
  const generate = async (systemPrompt: string, prompt: string, maxTokens: number) => {
    request.signal.throwIfAborted();
    const response = await llm.generateText({ usagePurpose: "synthesis", model: model.id, signal: request.signal, systemPrompt, prompt, maxTokens, localReasoningBudget: 0, timeoutMs: LONG_REQUEST_MS }, model.providerId);
    request.spent(response.usage);
    if (response.error) throw new SynthesisError(`${model.id}: ${response.error}`);
    return response.text.trim();
  };
  let items = request.results.map(findingsOf);
  for (let round = 1; items.join("\n\n").length > budget * 0.8 && items.length > 1; round++) {
    if (round > 6) throw new SynthesisError("The agents' results do not fit the model even after merging them six times.");
    const groups: string[][] = [];
    for (const item of items) {
      const last = groups.at(-1);
      if (last && last.join("\n\n").length + item.length < budget * 0.4) last.push(item); else groups.push([item.slice(0, Math.floor(budget * 0.4))]);
    }
    await request.progress?.(`Merging ${items.length} results in ${groups.length} groups`);
    const merged: string[] = [];
    for (const group of groups) merged.push(await generate("You merge findings of software agents. Keep every concrete finding and every path:line reference exactly; drop repetition; no preamble.",
      `Merge these findings into one list:\n\n${group.join("\n\n")}`, OUTPUT_TOKENS));
    items = merged;
  }
  const text = await generate(`You write ${request.file} for the module ${request.module} from the findings of agents that worked in parallel. Write only the file's content.`, [
    `Module ${request.module}: ${request.description}`.slice(0, 4000),
    request.instruction ? `What ${request.file} must be: ${request.instruction}` : `Write ${request.file} as Markdown: a title, a short summary, then the findings grouped by topic, each with its path:line reference, the most important first. Merge repeated findings; say which tasks failed. Keep it under 2,500 words.`,
    request.feedback?.length ? `The last ${request.file} failed the contract's checks. This one must not:\n${request.feedback.map((item, index) => `${index + 1}. ${item}`).join("\n").slice(0, 6000)}` : "",
    // A repair edits the last version: rewriting it whole would lose what already held.
    request.feedback?.length && request.current ? `The last ${request.file}, to correct (change only what the problems above require, keep the rest as it is, and answer with the whole corrected file):\n\n${request.current.slice(0, Math.floor(budget / 3))}` : "",
    `Findings:\n\n${items.join("\n\n")}`
  ].filter(Boolean).join("\n\n"), OUTPUT_TOKENS);
  const fenced = /^```[\w+#.-]*\s*\n([\s\S]*?)\n```$/.exec(text);
  return fenced ? fenced[1] : text;
}
