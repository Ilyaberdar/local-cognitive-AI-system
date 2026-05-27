import { ManagedModel } from "../types";

interface LMStudioManagerOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
}

interface NativeModelRecord {
  modelKey?: string;
  key?: string;
  displayName?: string;
  display_name?: string;
  sizeBytes?: number;
  size_bytes?: number;
  size?: number;
  bytes?: number;
  state?: {
    loaded?: boolean;
  };
  loadedInstanceIds?: string[];
  loaded_instances?: Array<{
    id?: string;
  }>;
}

export class LMStudioManager {
  private readonly nativeBaseUrl: string;

  constructor(private readonly options: LMStudioManagerOptions) {
    this.nativeBaseUrl = options.baseUrl.replace(/\/v1\/?$/, "");
  }

  async listAllModels(): Promise<ManagedModel[]> {
    let payload: {
      data?: NativeModelRecord[];
      models?: NativeModelRecord[];
    };

    try {
      payload = await this.request<{
        data?: NativeModelRecord[];
        models?: NativeModelRecord[];
      }>("/api/v1/models", {
        method: "GET"
      });
    } catch {
      return [];
    }

    const records = payload.models ?? payload.data ?? [];

    return records
      .map((model) => ({
        id: model.key ?? model.modelKey ?? "unknown-model",
        displayName:
          model.display_name ?? model.displayName ?? model.key ?? model.modelKey ?? "unknown-model",
        sizeBytes: [model.sizeBytes, model.size_bytes, model.size, model.bytes].find(
          (value): value is number => typeof value === "number" && Number.isFinite(value)
        ),
        loaded:
          Boolean(model.state?.loaded) ||
          Boolean(model.loaded_instances?.length) ||
          Boolean(model.loadedInstanceIds?.length),
        loadedInstanceIds: Array.isArray(model.loaded_instances)
          ? model.loaded_instances
              .map((instance) => instance.id)
              .filter((instanceId): instanceId is string => Boolean(instanceId))
          : Array.isArray(model.loadedInstanceIds)
            ? model.loadedInstanceIds
            : []
      }))
      .filter((model) => model.id !== "unknown-model")
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async listLoadedModels(): Promise<ManagedModel[]> {
    const models = await this.listAllModels();
    return models.filter((model) => model.loaded || model.loadedInstanceIds.length > 0);
  }

  async loadModel(modelKey: string): Promise<void> {
    await this.request("/api/v1/models/load", {
      method: "POST",
      body: {
        model: modelKey
      }
    });
  }

  async unloadModel(identifier: string): Promise<void> {
    const loadedModels = await this.listLoadedModels();
    const byModel = loadedModels.find((model) => model.id === identifier);

    if (byModel?.loadedInstanceIds.length) {
      await Promise.all(
        byModel.loadedInstanceIds.map((instanceId) =>
          this.request("/api/v1/models/unload", {
            method: "POST",
            body: { instance_id: instanceId }
          })
        )
      );
      return;
    }

    await this.request("/api/v1/models/unload", {
      method: "POST",
      body: {
        instance_id: identifier
      }
    });
  }

  private async request<T = unknown>(
    pathname: string,
    options: {
      method: "GET" | "POST";
      body?: Record<string, unknown>;
    }
  ): Promise<T> {
    const response = await fetch(`${this.nativeBaseUrl}${pathname}`, {
      method: options.method,
      headers: {
        "Content-Type": "application/json",
        ...(this.options.apiKey
          ? {
              Authorization: `Bearer ${this.options.apiKey}`
            }
          : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(this.options.timeoutMs)
    });

    if (!response.ok) {
      throw new Error(`LM Studio request failed with status ${response.status}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return (await response.json()) as T;
  }
}
