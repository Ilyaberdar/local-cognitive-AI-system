export interface AgentLimits {
  maxSteps: number;
  advisorMaxSteps: number;
  maxTotalSteps: number;
  maxActiveMs: number;
  maxRepairs: number;
  contextChars: number;
}

export const defaultAgentLimits: Readonly<AgentLimits> = Object.freeze({
  maxSteps: 24, advisorMaxSteps: 6, maxTotalSteps: 48,
  maxActiveMs: 600_000, maxRepairs: 3, contextChars: 48_000
});

const bounds: Record<keyof AgentLimits, [number, number]> = {
  maxSteps: [1, 200], advisorMaxSteps: [1, 48], maxTotalSteps: [1, 400],
  maxActiveMs: [1_000, 3_600_000], maxRepairs: [1, 10], contextChars: [4_096, 200_000]
};

const environment: Record<keyof AgentLimits, string> = {
  maxSteps: "AGENT_MAX_STEPS", advisorMaxSteps: "AGENT_ADVISOR_MAX_STEPS", maxTotalSteps: "AGENT_MAX_TOTAL_STEPS",
  maxActiveMs: "AGENT_MAX_ACTIVE_MS", maxRepairs: "AGENT_MAX_REPAIRS", contextChars: "AGENT_CONTEXT_CHARS"
};

/** Server configuration only: invalid values use defaults; finite values are bounded. */
export function normalizeAgentLimits(input: Partial<AgentLimits> = {}): AgentLimits {
  const result = { ...defaultAgentLimits };
  for (const key of Object.keys(bounds) as Array<keyof AgentLimits>) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      result[key] = Math.max(bounds[key][0], Math.min(bounds[key][1], Math.floor(value)));
    }
  }
  return result;
}

export function readAgentLimits(fileValue: unknown, env: NodeJS.ProcessEnv = process.env): AgentLimits {
  const record = fileValue && typeof fileValue === "object" && !Array.isArray(fileValue) ? fileValue as Record<string, unknown> : {};
  const values: Partial<AgentLimits> = {};
  for (const key of Object.keys(bounds) as Array<keyof AgentLimits>) {
    const raw = env[environment[key]];
    const value = raw === undefined || !raw.trim() ? record[key] : Number(raw);
    if (typeof value === "number") values[key] = value;
  }
  return normalizeAgentLimits(values);
}

/** Existing runs keep their original ceiling; tightening server limits also applies on resume. */
export function restrictAgentLimits(saved: AgentLimits | undefined, current: AgentLimits): AgentLimits {
  if (!saved) return current;
  const prior = normalizeAgentLimits(saved);
  return Object.fromEntries((Object.keys(current) as Array<keyof AgentLimits>).map(key => [key, Math.min(prior[key], current[key])])) as unknown as AgentLimits;
}
