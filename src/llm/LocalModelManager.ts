import { ManagedModel } from "../types";

export interface LocalModelManager {
  readonly providerId: string;
  readonly providerName: string;
  listAllModels(): Promise<ManagedModel[]>;
  listLoadedModels(): Promise<ManagedModel[]>;
  loadModel(modelId: string): Promise<void>;
  unloadModel(identifier: string): Promise<void>;
}

export class LocalModelManagerRegistry {
  private readonly managers = new Map<string, LocalModelManager>();

  constructor(managers: LocalModelManager[]) {
    for (const manager of managers) {
      this.register(manager);
    }
  }

  register(manager: LocalModelManager): void {
    this.managers.set(manager.providerId, manager);
  }

  async listAllModels(providerId?: string): Promise<ManagedModel[]> {
    const managers = this.selectManagers(providerId);
    const groups = await Promise.all(managers.map((manager) => manager.listAllModels()));
    return this.sort(groups.flat());
  }

  async listLoadedModels(providerId?: string): Promise<ManagedModel[]> {
    const managers = this.selectManagers(providerId);
    const groups = await Promise.all(managers.map((manager) => manager.listLoadedModels()));
    return this.sort(groups.flat());
  }

  async loadModel(providerId: string, modelId: string): Promise<void> {
    await this.get(providerId).loadModel(modelId);
  }

  async unloadModel(providerId: string, identifier: string): Promise<void> {
    await this.get(providerId).unloadModel(identifier);
  }

  private get(providerId: string): LocalModelManager {
    const manager = this.managers.get(providerId);

    if (!manager) {
      throw new Error(`Local model provider "${providerId}" is not registered`);
    }

    return manager;
  }

  private selectManagers(providerId?: string): LocalModelManager[] {
    return providerId ? [this.get(providerId)] : Array.from(this.managers.values());
  }

  private sort(models: ManagedModel[]): ManagedModel[] {
    return models.sort((left, right) => {
      if (left.providerId !== right.providerId) {
        return left.providerName.localeCompare(right.providerName);
      }

      if (left.loaded !== right.loaded) {
        return left.loaded ? -1 : 1;
      }

      return (left.displayName || left.id).localeCompare(right.displayName || right.id);
    });
  }
}
