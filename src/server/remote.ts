import os from "os";
import type { HostServices } from "../index";
import type { CredentialVault } from "../plugins/contracts";
import { HostAgent } from "../remote/host/HostAgent";
import type { RemoteOperation } from "../remote/host/RemoteHost";
import { RemoteHostStore } from "../remote/host/RemoteHostStore";
import { hostUsageSender, type UsageOutbox } from "../usage/UsageOutbox";
import { appVersion } from "../utils/appVersion";
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
  const hostName = os.hostname().slice(0, 120);
  // Host operations plus the chat operations (R4); every screen arrives in R5. Nothing here returns paths.
  const operations: Record<string, RemoteOperation> = {
    "session.ping": () => ({ at: Date.now() }),
    "host.info": () => ({ name: hostName, version: appVersion(), platform: process.platform, arch: process.arch }),
    "host.status": () => input.status(),
    ...input.operations
  };
  const store = new RemoteHostStore(input.host.database);
  const agent = new HostAgent({ cloudUrl, store, vault: input.vault, hostName, serverVersion: appVersion(), operations, logger: input.logger });
  try { await agent.start(); } catch (error) { return off(error instanceof Error ? error.message : String(error)); }
  // Usage goes to the Cloud signed by this server, for its owner only.
  input.usage?.setSender(hostUsageSender({ cloudUrl, hostId: () => store.hostId(), owner: () => store.owner(), sign: payload => agent.signUsage(payload) }));
  // The backend owns the database and closes it after the agent stopped.
  return { agent, close() { agent.stop(); } };
};
