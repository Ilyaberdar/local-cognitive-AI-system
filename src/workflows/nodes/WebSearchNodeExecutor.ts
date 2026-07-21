import { NodeResult } from "../types";
import { readConfigNumber, readConfigString, renderWorkflowTemplate } from "../template";
import { NodeExecutionContext, NodeExecutor } from "./NodeExecutor";

interface WebSearchNodeExecutorOptions {
  braveApiKey?: string;
  searxngUrl?: string;
  fetchImpl?: typeof fetch;
}

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export class WebSearchNodeExecutor implements NodeExecutor {
  readonly type = "web_search" as const;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: WebSearchNodeExecutorOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async execute(context: NodeExecutionContext): Promise<NodeResult> {
    const config = context.node.config;
    const query = renderWorkflowTemplate(
      readConfigString(config, "queryTemplate", "{{task.title}} {{task.description}}"),
      context
    ).trim();
    const limit = readConfigNumber(config, "limit", 8, 1, 20);
    const provider = readConfigString(
      config,
      "provider",
      this.options.braveApiKey ? "brave" : "searxng"
    );

    if (!query) {
      throw new Error("Web search query is empty.");
    }

    const results = provider === "brave"
      ? await this.searchBrave(query, limit)
      : await this.searchSearxng(query, limit, readConfigString(config, "baseUrl", this.options.searxngUrl ?? ""));

    return {
      status: "ok",
      event: "web_search.completed",
      summary: `Web search returned ${results.length} results for "${query}".`,
      data: { provider, query, results }
    };
  }

  private async searchBrave(query: string, limit: number): Promise<WebSearchResult[]> {
    if (!this.options.braveApiKey) {
      throw new Error("BRAVE_SEARCH_API_KEY is required for provider=brave.");
    }

    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(limit));
    const response = await this.fetchJson(url, {
      Accept: "application/json",
      "X-Subscription-Token": this.options.braveApiKey
    });
    const web = readRecord(response.web);
    const values = Array.isArray(web.results) ? web.results : [];

    return values.slice(0, limit).map((item) => {
      const record = readRecord(item);
      return {
        title: String(record.title ?? "Untitled"),
        url: String(record.url ?? ""),
        snippet: String(record.description ?? "")
      };
    }).filter((item) => Boolean(item.url));
  }

  private async searchSearxng(query: string, limit: number, baseUrl: string): Promise<WebSearchResult[]> {
    if (!baseUrl) {
      throw new Error("SEARXNG_URL or node config baseUrl is required for provider=searxng.");
    }

    const url = new URL("/search", ensureTrailingSlash(baseUrl));
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    const response = await this.fetchJson(url, { Accept: "application/json" });
    const values = Array.isArray(response.results) ? response.results : [];

    return values.slice(0, limit).map((item) => {
      const record = readRecord(item);
      return {
        title: String(record.title ?? "Untitled"),
        url: String(record.url ?? ""),
        snippet: String(record.content ?? "")
      };
    }).filter((item) => Boolean(item.url));
  }

  private async fetchJson(url: URL, headers: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(30_000)
    });

    if (!response.ok) {
      throw new Error(`Web search failed with HTTP ${response.status}.`);
    }

    return readRecord(await response.json());
  }
}

const readRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const ensureTrailingSlash = (value: string): string => value.endsWith("/") ? value : `${value}/`;
