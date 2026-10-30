import type { BackendHandle, HostServices } from "../../index";
import type { CredentialVault } from "../../plugins/contracts";
import { createChatOperations, createChatScrubber, requireRemoteSession } from "../../runtime/chatOperations";
import { createDiagnosticsOperations } from "../../runtime/diagnosticsOperations";
import { createEventStreamOperations } from "../../runtime/eventStreams";
import { createFolderOperations } from "../../runtime/folderOperations";
import { HostFolders } from "../../runtime/hostFolders";
import { createModelOperations } from "../../runtime/modelOperations";
import { createOrchestrationOperations, createWorkflowRunStreams } from "../../runtime/orchestrationOperations";
import { createProjectAccess, createProjectOperations, PROJECT_ON_HOST } from "../../runtime/projectOperations";
import { createSettingsOperations } from "../../runtime/settingsOperations";
import { createSynthesisOperations } from "../../runtime/synthesisOperations";
import { UploadStore } from "../../runtime/uploadStore";
import { createUsageOperations } from "../../runtime/usageOperations";
import { hostUsageSender, type UsageOutbox } from "../../usage/UsageOutbox";
import { appVersion } from "../../utils/appVersion";
import type { Logger } from "../../utils/Logger";
import { HostAgent } from "./HostAgent";
import type { RemoteOperation } from "./RemoteHost";
import { RemoteHostStore } from "./RemoteHostStore";

/** A headless server, or the desktop app hosting from the computer it runs on. */
export type HostKind = "server" | "desktop";

/** What paired devices may do on this host (spec §7), for a server and a desktop alike: chats,
 * event streams, models, usage, diagnostics, tasks and workflows, settings, folders, Synthesis and
 * projects. `dataRoot` is the folder the host's data lives in (the server's data root, the desktop's
 * userData): devices never see it named, and its "projects" folder is the one they manage. */
export const createHostOperations = (input: { backend: BackendHandle; dataRoot: string; consentFile?: string;
  /** On a desktop: what devices may not approve (deviceApprovals.ts), read at every approval. */
  approvalPolicy?: (operation: Record<string, unknown>) => string | undefined;
  /** On a desktop: devices open a chat's files only from its own folder and the shared folders. */
  deviceFilesOnly?: boolean }): {
  operations: Record<string, RemoteOperation>; folders: HostFolders; stop(): void;
} => {
  const { backend } = input;
  const host = backend.host;
  if (!host) throw new Error("Remote hosting needs the backend's host services.");
  const sessionIndexStore = backend.runtimeManager.getRuntime().sessionIndexStore;
  const isDraining = () => backend.status().phase === "draining";
  const scopeOf = (context: { accountId: string; deviceId: string }) => `remote:${context.accountId}:${context.deviceId}`;
  const owner = () => new RemoteHostStore(host.database).owner();
  // Run outputs and events a device receives name no folder of this host.
  const orchestration = { runtimeManager: backend.runtimeManager, journalEpoch: () => host.journal.epoch, hostDirectories: [input.dataRoot] };
  // The folders devices may browse and use: the host's own "Projects" and those its owner shared.
  const folders = new HostFolders(input.dataRoot);
  folders.ensureManaged();
  // A project a device may use lies in one of those folders, checked at every use.
  const projects = createProjectAccess({ runtimeManager: backend.runtimeManager, folders });
  // A device's turn in a project chat stops once the project is archived or its folder unshared.
  host.runService.setGuard(async sessionId => {
    const projectId = (await sessionIndexStore.get(sessionId))?.projectId;
    if (!projectId) return undefined;
    if (!await projects.visible(projectId)) return PROJECT_ON_HOST();
    return (await projects.usable(projectId)).reason;
  });
  // Attachments devices send for their next turn; expired ones are dropped even when none arrive.
  const uploads = new UploadStore();
  const sweep = setInterval(() => uploads.sweep(), 60 * 60 * 1000);
  sweep.unref();
  const operations: Record<string, RemoteOperation> = {
    ...createChatOperations({ runtimeManager: backend.runtimeManager, sessionIndexStore, hostDirectories: orchestration.hostDirectories, uploads, projects,
      runService: host.runService, journal: host.journal, scopeOf, ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
      ...(input.deviceFilesOnly ? { deviceFileRoots: async (sessionId: string) => [backend.runtimeManager.getRuntime().workspaceResolver.deviceChatFolder(sessionId),
        ...folders.roots().map(root => root.path)] } : {}) }),
    ...createEventStreamOperations({ journal: host.journal, requireSession: sessionId => requireRemoteSession(sessionIndexStore, sessionId, projects),
      sources: [createWorkflowRunStreams(orchestration)], scrubSession: createChatScrubber(orchestration) }),
    ...createModelOperations({ runtimeManager: backend.runtimeManager }),
    ...createUsageOperations({ ledger: backend.usage, outbox: backend.usageOutbox, owner }),
    ...createDiagnosticsOperations({ runtimeManager: backend.runtimeManager, diagnosticLog: backend.diagnosticLog, owner, status: () => backend.status(),
      ...(input.consentFile ? { consentFile: input.consentFile } : {}) }),
    ...createOrchestrationOperations({ ...orchestration, ledger: host.ledger, projects, folders, scopeOf, isDraining, ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}) }),
    ...createSettingsOperations({ runtimeManager: backend.runtimeManager, isDraining }),
    ...createFolderOperations({ folders }),
    ...createSynthesisOperations({ runtimeManager: backend.runtimeManager, ledger: host.ledger, projects, hostDirectories: orchestration.hostDirectories, scopeOf, isDraining }),
    ...createProjectOperations({ runtimeManager: backend.runtimeManager, folders, ledger: host.ledger, scopeOf, isDraining })
  };
  return { operations, folders, stop: () => clearInterval(sweep) };
};

/** The operations every host answers itself: a ping, what it is, and its status. Nothing here
 * returns paths. */
export const builtInHostOperations = (input: { hostName: string; kind: HostKind; status: () => Record<string, unknown> }): Record<string, RemoteOperation> => ({
  "session.ping": () => ({ at: Date.now() }),
  "host.info": () => ({ name: input.hostName, version: appVersion(), platform: process.platform, arch: process.arch, kind: input.kind }),
  "host.status": () => input.status()
});

/** Connects this host to Local Cognitive Cloud: its identity in the vault, registration and the relay.
 * A server's usage goes signed by it for its owner; a desktop sends its own with the account's token. */
export const startHostAgent = async (input: { host: HostServices; vault: CredentialVault; cloudUrl: string; hostName: string; kind: HostKind; logger: Logger;
  status: () => Record<string, unknown>; operations: Record<string, RemoteOperation>; usage?: UsageOutbox; expectedOwner?: () => string | undefined }): Promise<HostAgent> => {
  const store = new RemoteHostStore(input.host.database);
  const agent = new HostAgent({ cloudUrl: input.cloudUrl, store, vault: input.vault, hostName: input.hostName, serverVersion: appVersion(), logger: input.logger,
    operations: { ...builtInHostOperations(input), ...input.operations }, kind: input.kind, ...(input.expectedOwner ? { expectedOwner: input.expectedOwner } : {}) });
  await agent.start();
  input.usage?.setSender(hostUsageSender({ cloudUrl: input.cloudUrl, hostId: () => store.hostId(), owner: () => store.owner(), sign: payload => agent.signUsage(payload) }));
  return agent;
};
