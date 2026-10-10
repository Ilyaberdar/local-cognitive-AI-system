import os from "node:os";
import { z } from "zod";
import type { RuntimeManager } from "../app/RuntimeManager";
import { PROTOCOL_VERSION } from "../remote/channel";
import { appVersion } from "../utils/appVersion";
import type { DiagnosticLog } from "./DiagnosticLog";
import { diagnosticCode } from "./events";

const GiB = 1024 ** 3;
const count = z.number().int().min(0);
const counts = z.record(diagnosticCode, count);
/** A product name a driver reports (a GPU): letters, digits and simple punctuation only. */
const productName = z.string().regex(/^[\w .()+\-/]{1,80}$/);

/** A runtime's diagnostics as a bug report shows and sends them: versions, system, states and
 * counts. A strict schema: a new field is a reviewed change, and nothing of the user's (names,
 * addresses, paths, model files, prompts) has a place in it. */
export const runtimeDiagnosticsSchema = z.object({
  runtimeKind: z.enum(["desktop", "server"]),
  app: z.object({ version: z.string().max(40), node: z.string().max(40), protocol: z.number().int() }).strict(),
  os: z.object({ platform: z.string().max(20), arch: z.string().max(20), release: z.string().max(80) }).strict(),
  hardware: z.object({ memoryGb: count, cpus: count, gpus: z.array(z.object({ name: productName, vramGb: count }).strict()).max(16) }).strict(),
  localRuntime: z.object({ status: diagnosticCode, backend: diagnosticCode, runtimeId: diagnosticCode.optional(), placement: diagnosticCode.optional(),
    loadedModels: count, hasError: z.boolean(), cpuFallback: z.boolean() }).strict().optional(),
  providers: z.array(z.object({ id: diagnosticCode, enabled: z.boolean(), hasKey: z.boolean() }).strict()).max(20),
  mcp: z.object({ servers: count, states: counts, errors: counts }).strict(),
  recentErrors: z.array(z.object({ event: diagnosticCode, n: count, last: z.iso.datetime() }).strict()).max(40)
}).strict();
export type RuntimeDiagnostics = z.infer<typeof runtimeDiagnosticsSchema>;

const code = (value: unknown, fallback = "unknown"): string => {
  const text = String(value ?? "").toLowerCase();
  return diagnosticCode.safeParse(text).success ? text : fallback;
};
const tally = (values: string[]): Record<string, number> => values.reduce<Record<string, number>>((all, value) => ({ ...all, [value]: (all[value] ?? 0) + 1 }), {});

/** The technical log of the last two weeks, by event: how often, and when last. */
export const recentErrors = (log: Pick<DiagnosticLog, "tail"> | undefined): RuntimeDiagnostics["recentErrors"] => {
  const byEvent = new Map<string, { n: number; last: string }>();
  for (const entry of log?.tail({ days: 14 }) ?? []) {
    if (entry.event === "app.started") continue;
    const seen = byEvent.get(entry.event) ?? { n: 0, last: entry.at };
    byEvent.set(entry.event, { n: seen.n + entry.n, last: entry.at > seen.last ? entry.at : seen.last });
  }
  return [...byEvent].map(([event, value]) => ({ event, ...value })).sort((a, b) => b.last.localeCompare(a.last)).slice(0, 40);
};

/** Collects this runtime's diagnostics; any part it cannot read is left out, never guessed. */
export async function collectRuntimeDiagnostics(deps: { runtimeManager: RuntimeManager; diagnosticLog?: Pick<DiagnosticLog, "tail">; runtimeKind: "desktop" | "server" }): Promise<RuntimeDiagnostics> {
  let localRuntime: RuntimeDiagnostics["localRuntime"], gpus: RuntimeDiagnostics["hardware"]["gpus"] = [];
  let providers: RuntimeDiagnostics["providers"] = [], mcp: RuntimeDiagnostics["mcp"] = { servers: 0, states: {}, errors: {} };
  try {
    const runtime = deps.runtimeManager.getRuntime();
    const snapshot = runtime.localModelService.snapshot().runtime;
    localRuntime = { status: code(snapshot.status), backend: code(snapshot.backend), ...(snapshot.runtimeId ? { runtimeId: code(snapshot.runtimeId) } : {}),
      ...(snapshot.placement?.kind ? { placement: code(snapshot.placement.kind) } : {}),
      loadedModels: snapshot.loadedModelIds?.length ?? (snapshot.modelId ? 1 : 0), hasError: Boolean(snapshot.error), cpuFallback: Boolean(snapshot.fallbackReason) };
    gpus = (snapshot.gpus ?? []).slice(0, 16).flatMap(gpu => productName.safeParse(gpu.name).success ? [{ name: gpu.name, vramGb: Math.round(gpu.totalBytes / GiB) }] : []);
    const statuses = runtime.mcpClients.list();
    mcp = { servers: statuses.length, states: tally(statuses.map(status => code(status.state))), errors: tally(statuses.flatMap(status => status.error ? [code(status.error.code)] : [])) };
  } catch { /* The runtime is not built: its parts are left out. */ }
  try {
    const settings = await deps.runtimeManager.getSettings();
    providers = Object.entries(settings.providers ?? {}).slice(0, 20).map(([id, provider]) => ({ id: code(id), enabled: provider.enabled !== false, hasKey: Boolean(provider.apiKey) }));
  } catch { /* Settings unreadable: left out. */ }
  return runtimeDiagnosticsSchema.parse({
    runtimeKind: deps.runtimeKind,
    app: { version: appVersion(), node: process.versions.node, protocol: PROTOCOL_VERSION },
    os: { platform: process.platform, arch: process.arch, release: os.release().slice(0, 80) },
    hardware: { memoryGb: Math.round(os.totalmem() / GiB), cpus: os.cpus().length, gpus },
    ...(localRuntime ? { localRuntime } : {}),
    providers, mcp, recentErrors: recentErrors(deps.diagnosticLog)
  });
}
