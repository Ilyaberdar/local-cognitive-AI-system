import { ManagedModel } from "../types";
import { LocalModelManager } from "./LocalModelManager";

interface OllamaModelManagerOptions {
  baseUrl: string;
  timeoutMs: number;
}

interface OllamaModelRecord {
  name?: string;
  model?: string;
  size?: number;
  size_vram?: number;
  digest?: string;
  expires_at?: string;
}

export class OllamaModelManager implements LocalModelManager {
  readonly providerId = "ollama";
  readonly providerName = "Ollama";
  private readonly baseUrl: string;

  constructor(private readonly options: OllamaModelManagerOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  async listAllModels(): Promise<ManagedModel[]> {
    let payload: { models?: OllamaModelRecord[] };

    try {
      payload = await this.request<{ models?: OllamaModelRecord[] }>("/api/tags", {
        method: "GET"
      });
    } catch {
      return [];
    }

    const loadedById = new Map(
      (await this.listLoadedModels()).map((model) => [model.id, model])
    );

    return (payload.models ?? [])
      .map((model) => {
        const id = this.readModelId(model);
        const loadedModel = id ? loadedById.get(id) : undefined;

        return {
          id: id ?? "unknown-model",
          displayName: id ?? "unknown-model",
          providerId: this.providerId,
          providerName: this.providerName,
          sizeBytes: this.readSize(model),
          loaded: Boolean(loadedModel),
          loadedInstanceIds: loadedModel?.loadedInstanceIds ?? []
        } satisfies ManagedModel;
      })
      .filter((model) => model.id !== "unknown-model")
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async listLoadedModels(): Promise<ManagedModel[]> {
    let payload: { models?: OllamaModelRecord[] };

    try {
      payload = await this.request<{ models?: OllamaModelRecord[] }>("/api/ps", {
        method: "GET"
      });
    } catch {
      return [];
    }

    return (payload.models ?? [])
      .map((model) => {
        const id = this.readModelId(model);

        return {
          id: id ?? "unknown-model",
          displayName: id ?? "unknown-model",
          providerId: this.providerId,
          providerName: this.providerName,
          sizeBytes: this.readSize(model),
          loaded: true,
          loadedInstanceIds: id ? [id] : []
        } satisfies ManagedModel;
      })
      .filter((model) => model.id !== "unknown-model")
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async loadModel(modelId: string): Promise<void> {
    await this.request("/api/generate", {
      method: "POST",
      body: {
        model: modelId,
        prompt: "",
        stream: false,
        keep_alive: "5m"
      }
    });
  }

  async unloadModel(identifier: string): Promise<void> {
    await this.request("/api/generate", {
      method: "POST",
      body: {
        model: identifier,
        prompt: "",
        stream: false,
        keep_alive: 0
      }
    });
  }

  private readModelId(model: OllamaModelRecord): string | undefined {
    return model.model ?? model.name;
  }

  private readSize(model: OllamaModelRecord): number | undefined {
    return [model.size_vram, model.size].find(
      (value): value is number => typeof value === "number" && Number.isFinite(value)
    );
  }

  private async request<T = unknown>(
    pathname: string,
    options: {
      method: "GET" | "POST";
      body?: Record<string, unknown>;
    }
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${pathname}`, {
      method: options.method,
      headers: {
        "Content-Type": "application/json"
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(this.options.timeoutMs)
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed with status ${response.status}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return (await response.json()) as T;
  }
}
