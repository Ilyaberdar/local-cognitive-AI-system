import os from "os";
import type { HostServices } from "../index";
import type { CredentialVault } from "../plugins/contracts";
import type { HostAgent } from "../remote/host/HostAgent";
import type { RemoteOperation } from "../remote/host/RemoteHost";
import { startHostAgent } from "../remote/host/hostRuntime";
import type { UsageOutbox } from "../usage/UsageOutbox";
import type { Logger } from "../utils/Logger";

export const DEFAULT_CLOUD_URL = "https://api.local-cognitive.com";
const loopback = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

/** The Cloud this server pairs through: https, or loopback http for development. */
export const remoteCloudUrl = (env: NodeJS.ProcessEnv): string => {
  const value = (env.LOCAL_COGNITIVE_CLOUD_URL || DEFAULT_CLOUD_URL).replace(/\/$/, "");
  const url = new URL(value);
  if (url.protocol !== "https:" && !loopback.test(url.origin)) throw new Error("LOCAL_COGNITIVE_CLOUD_URL must use https (or http on loopback).");
  return url.origin;
};

export interface RemoteRuntime { agent?: HostAgent; disabledReason?: string; close(): void }

/** Starts Remote on a headless server: the host database, its identity in the vault and the
 * Cloud connection. Without credential storage or with LOCAL_COGNITIVE_REMOTE=off it stays off. */
export const startRemote = async (input: { host: HostServices; vault: CredentialVault; vaultConfigured: boolean; env: NodeJS.ProcessEnv; logger: Logger;
  status: () => Record<string, unknown>; operations?: Record<string, RemoteOperation>; usage?: UsageOutbox }): Promise<RemoteRuntime> => {
  const off = (disabledReason: string): RemoteRuntime => { input.logger.warn(`Remote is off: ${disabledReason}`); return { disabledReason, close() {} }; };
  if (input.env.LOCAL_COGNITIVE_REMOTE === "off") return { disabledReason: "Remote is turned off (LOCAL_COGNITIVE_REMOTE=off).", close() {} };
  if (!input.vaultConfigured) return off("credential storage is not configured; run local-cognitive-server init.");
  let cloudUrl: string;
  try { cloudUrl = remoteCloudUrl(input.env); } catch (error) { return off(error instanceof Error ? error.message : String(error)); }
  let agent: HostAgent;
  try {
    agent = await startHostAgent({ host: input.host, vault: input.vault, cloudUrl, hostName: os.hostname().slice(0, 120), kind: "server", logger: input.logger,
      status: input.status, operations: input.operations ?? {}, ...(input.usage ? { usage: input.usage } : {}) });
  } catch (error) { return off(error instanceof Error ? error.message : String(error)); }
  // The backend owns the database and closes it after the agent stopped.
  return { agent, close() { agent.stop(); } };
};
