import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { isMissingFile, withFileLock, writeJsonAtomically } from "../utils/fileStore";
import { PluginInstallation, ServiceConnection } from "./contracts";

const id = z.string().min(1).max(200);
const schema = z.object({
  version: z.literal(1), ownerId: id,
  installations: z.array(z.object({ pluginId: id, version: id, installedAt: id, enabled: z.boolean(),
    permission: z.enum(["none", "read", "read-write"]), connectionId: id.optional(), revision: id }).strict()),
  connections: z.array(z.object({ id, pluginId: id, ownerId: id, adapter: id, accountRef: id, label: z.string().max(500), createdAt: id, revision: id }).strict())
}).strict();
export interface PluginState { version: 1; ownerId: string; installations: PluginInstallation[]; connections: ServiceConnection[]; }

export class PluginStore {
  readonly file: string;
  readonly directory: string;
  constructor(baseDir: string, private readonly ownerId: string) {
    this.directory = path.join(baseDir, "integrations", "owners", createHash("sha256").update(ownerId).digest("hex"));
    this.file = path.join(this.directory, "state.json");
  }
  async read(): Promise<PluginState> {
    try {
      const state = schema.parse(JSON.parse(await fs.readFile(this.file, "utf8")));
      if (state.ownerId !== this.ownerId || state.connections.some(connection => connection.ownerId !== this.ownerId)) throw new Error("Plugin state belongs to another local profile.");
      return state;
    } catch (error) {
      if (isMissingFile(error)) return { version: 1, ownerId: this.ownerId, installations: [], connections: [] };
      throw error;
    }
  }
  async update<T>(change: (state: PluginState) => T | Promise<T>): Promise<T> {
    return withFileLock(this.file, async () => {
      const state = await this.read();
      const result = await change(state);
      schema.parse(state);
      await writeJsonAtomically(this.file, state);
      return result;
    });
  }
}
