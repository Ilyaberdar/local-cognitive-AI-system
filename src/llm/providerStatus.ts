import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isMissingFile, writeJsonAtomically } from "../utils/fileStore";
import { isKeyRefusal, ProviderHttpError } from "./ProviderHttpError";

/** How a provider answered its last check: its model list (a free request) with the saved key. */
export type ProviderState = "connected" | "rejected" | "unreachable" | "failed";
export interface ProviderStatus {
  state: ProviderState;
  checkedAt: string;
  message: string;
  httpStatus?: number;
  models?: number;
  /** The address and key the check used, as a short hash: a new key or address makes the result stale. */
  fingerprint: string;
}
interface ProviderSettings { enabled?: boolean; baseUrl?: string; apiKey?: string; source?: string }

/** Never the key itself: 12 hex characters of a hash of the address and key. */
export const statusFingerprint = (provider: ProviderSettings): string =>
  createHash("sha256").update("local-cognitive/provider-status/v1\0").update(JSON.stringify([provider.baseUrl ?? "", provider.apiKey ?? "", provider.source ?? ""])).digest("hex").slice(0, 12);

/** Lists the provider's models within `timeoutMs` and says what that shows about its key and address. */
export async function checkProvider(list: () => Promise<unknown[]>, settings: ProviderSettings, timeoutMs = 10_000): Promise<ProviderStatus> {
  const base = { checkedAt: new Date().toISOString(), fingerprint: statusFingerprint(settings) };
  let timer: NodeJS.Timeout | undefined;
  try {
    const models = await Promise.race([list(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); })]);
    return { ...base, state: "connected", models: models.length, message: `${models.length} ${models.length === 1 ? "model" : "models"}` };
  } catch (error) {
    if (error instanceof ProviderHttpError) {
      if (isKeyRefusal(error.status, error.message) || error.status === 403) return { ...base, state: "rejected", httpStatus: error.status, message: `Key refused (HTTP ${error.status})` };
      return { ...base, state: error.status >= 500 ? "unreachable" : "failed", httpStatus: error.status, message: `HTTP ${error.status}` };
    }
    return { ...base, state: "unreachable", message: error instanceof Error && error.message === "timeout" ? "No answer" : "Not reachable" };
  } finally { if (timer) clearTimeout(timer); }
}

/** The last check of each provider, kept with the app's data (no keys), so the list shows it at once. */
export class ProviderStatusStore {
  private readonly file: string;
  constructor(appDataDir: string) { this.file = path.join(appDataDir, "provider-status.json"); }
  async read(): Promise<Record<string, ProviderStatus>> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as { providers?: Record<string, ProviderStatus> };
      return parsed.providers && typeof parsed.providers === "object" ? parsed.providers : {};
    } catch (error) {
      if (isMissingFile(error) || error instanceof SyntaxError) return {};
      throw error;
    }
  }
  /** Merges new results; providers that are gone from the settings are dropped. */
  async write(results: Record<string, ProviderStatus>, known: string[]): Promise<Record<string, ProviderStatus>> {
    const next = Object.fromEntries(Object.entries({ ...await this.read(), ...results }).filter(([id]) => known.includes(id)));
    await writeJsonAtomically(this.file, { version: 1, providers: next }, { mode: 0o600 });
    return next;
  }
}

/** Only results checked with the provider's current address and key. */
export const currentStatuses = (statuses: Record<string, ProviderStatus>, providers: Record<string, ProviderSettings>): Record<string, ProviderStatus> =>
  Object.fromEntries(Object.entries(statuses).filter(([id, status]) => providers[id] && status.fingerprint === statusFingerprint(providers[id]!)));
