import type { ReactNode } from "react";
import type { WorkflowNodeDefinition } from "./types";

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="fsm-field"><span>{label}</span>{children}</label>;
}

function outputs(node: WorkflowNodeDefinition): Array<[string, string]> {
  const data: Record<string, Array<[string, string]>> = {
    agent: [["data.response", "Full response"]],
    web_fetch: [["data.text", "Page text"], ["data.url", "Page URL"]],
    web_search: [["data.results", "Search results"]],
    file_read: [["data.content", "File contents"], ["data.path", "File path"]],
    file_write: [["data.path", "Saved file path"]],
    file_search: [["data.results", "Matches"]],
    command: [["data.stdout", "Standard output"], ["data.stderr", "Errors"], ["data.exitCode", "Exit code"]]
  };
  return [...(data[node.type] ?? []), ["summary", "Summary"]];
}

export function BindingField({ label, value, onChange, nodes, multiline = false, path = false }: {
  label: string; value: string; onChange: (value: string) => void; nodes: WorkflowNodeDefinition[]; multiline?: boolean; path?: boolean;
}) {
  return <div className="fsm-binding-field">
    <Field label={label}>{multiline
      ? <textarea rows={4} value={value} onChange={event => onChange(event.target.value)} spellCheck={false} />
      : <input value={value} onChange={event => onChange(event.target.value)} spellCheck={false} />}</Field>
    <select aria-label={`Insert into ${label}`} value="" onChange={event => {
      if (event.target.value) onChange(!multiline ? event.target.value : [value, event.target.value].filter(Boolean).join("\n"));
    }}>
      <option value="">Insert a step result…</option>
      {!path ? <option value="{{input.description}}">Run → Input instructions</option> : null}
      {nodes.map(node => <optgroup key={node.id} label={`${node.label} (${node.id})`}>
        {outputs(node).filter(([key]) => !path || key.endsWith(".path")).map(([key, title]) =>
          <option key={key} value={`{{nodes.${node.id}.${key}}}`}>{title}</option>)}
      </optgroup>)}
    </select>
  </div>;
}

export function NodeConfigFields({ node, nodes, onUpdate }: {
  node: WorkflowNodeDefinition; nodes: WorkflowNodeDefinition[]; onUpdate: (patch: Record<string, unknown>) => void;
}) {
  const config = node.config;
  const text = (key: string, fallback = "") => typeof config[key] === "string" ? String(config[key]) : fallback;
  const otherNodes = nodes.filter(item => item.id !== node.id);
  const binding = (key: string, label: string, multiline = false, path = false) =>
    <BindingField label={label} value={text(key)} onChange={value => onUpdate({ [key]: value })} nodes={otherNodes} multiline={multiline} path={path} />;
  switch (node.type) {
    case "agent": return <>
      <Field label="Prompt"><textarea rows={6} value={text("promptTemplate", "{{input.title}}\n\n{{input.description}}")}
        onChange={event => onUpdate({ promptTemplate: event.target.value })} placeholder="What should this agent do?" /></Field>
      {binding("contextTemplate", "Input context", true)}
      <p className="fsm-model-hint">Choose the results this agent should receive. Previous agents’ conversations are not added automatically.</p>
      <BindingField label="Files for agent to read" value={Array.isArray(config.inputFiles) ? config.inputFiles.join("\n") : ""}
        onChange={value => onUpdate({ inputFiles: value.split("\n") })} nodes={otherNodes} multiline path />
      <p className="fsm-model-hint">One path per line. The agent is instructed to read these files with its tools. To load text as a separate step, use Read file and select its contents as input context.</p>
      <Field label="Agent mode"><select value={text("mode", "code")} onChange={event => onUpdate({ mode: event.target.value })}>
        <option value="code">Code / file work</option><option value="general">General</option><option value="hypothesis">Hypothesis</option>
      </select></Field>
      {config.providerId === "llamacpp" ? <>
        <Field label="Thinking budget (tokens)"><input type="number" min={0} max={32768} placeholder="Model default" value={config.reasoningBudget === undefined ? "" : Number(config.reasoningBudget)} onChange={event => onUpdate({ reasoningBudget: event.target.value === "" ? undefined : Number(event.target.value) })} /></Field>
        <p className="fsm-model-hint">Local model thinking only. Leave empty for the model default; 0 disables thinking for this step. A small budget leaves more time for tool actions.</p>
      </> : null}
    </>;
    case "file_write": return <>
      {binding("path", "File path", false, true)}
      <Field label="Write mode"><select value={text("mode", "overwrite")} onChange={event => onUpdate({ mode: event.target.value })}>
        <option value="overwrite">Overwrite</option><option value="append">Append</option>
      </select></Field>
      {binding("contentTemplate", "File contents", true)}
    </>;
    case "file_read": return <>
      {binding("path", "File path", false, true)}
      <Field label="Start line"><input type="number" min={1} value={Number(config.startLine ?? 1)} onChange={event => onUpdate({ startLine: Number(event.target.value) })} /></Field>
      <Field label="End line (optional)"><input type="number" min={1} value={config.endLine === undefined ? "" : Number(config.endLine)} onChange={event => onUpdate({ endLine: event.target.value ? Number(event.target.value) : undefined })} /></Field>
      <p className="fsm-model-hint">Reads up to 200 lines by default, within the file tool’s output limit. Results show whether more text remains.</p>
    </>;
    case "web_fetch": return <>
      {binding("urlTemplate", "Page URL")}
      <Field label="Maximum text characters"><input type="number" min={500} max={100000} step={500} value={Number(config.maxChars ?? 12000)} onChange={event => onUpdate({ maxChars: Number(event.target.value) })} /></Field>
      <p className="fsm-model-hint">Reads HTML or text from a URL. Scripts are not executed. Use Page text as the next agent’s input context.</p>
    </>;
    case "web_search": return <>
      {binding("queryTemplate", "Search query", true)}
      <Field label="Search provider"><select value={text("provider", "searxng")} onChange={event => onUpdate({ provider: event.target.value })}><option value="searxng">SearXNG</option><option value="brave">Brave</option></select></Field>
      {text("provider", "searxng") === "searxng" ? <Field label="SearXNG URL"><input value={text("baseUrl")} onChange={event => onUpdate({ baseUrl: event.target.value })} /></Field> : null}
    </>;
    case "file_search": return <>
      {binding("root", "Search folder", false, true)}{binding("queryTemplate", "Search text")}
    </>;
    case "command": return <>
      <Field label="Executable"><input value={text("executable")} onChange={event => onUpdate({ executable: event.target.value })} /></Field>
      <Field label="Arguments (one per line)"><textarea rows={4} value={Array.isArray(config.args) ? config.args.join("\n") : ""} onChange={event => onUpdate({ args: event.target.value ? event.target.value.split("\n") : [] })} /></Field>
      {binding("cwd", "Working directory", false, true)}
      <Field label="Timeout (ms)"><input type="number" min={1000} max={120000} value={Number(config.timeoutMs ?? 30000)} onChange={event => onUpdate({ timeoutMs: Number(event.target.value) })} /></Field>
    </>;
    case "human_review": return <Field label="Review instructions"><textarea rows={4} value={text("prompt")} onChange={event => onUpdate({ prompt: event.target.value })} /></Field>;
    case "terminal": return <Field label="Final status"><select value={text("runStatus", "done")} onChange={event => onUpdate({ runStatus: event.target.value })}><option value="done">Done</option><option value="failed">Failed</option></select></Field>;
    default: return null;
  }
}
