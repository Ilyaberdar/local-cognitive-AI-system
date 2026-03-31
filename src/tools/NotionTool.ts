import { ToolExecutionRequest, ToolExecutionResult } from "../types";
import { Tool } from "./Tool.interface";

interface NotionToolOptions {
  apiKey?: string;
  parentPageId?: string;
  dataSourceId?: string;
  titleProperty: string;
  version: string;
}

export class NotionTool implements Tool {
  name = "notion";
  description = "Creates a note or summary page in Notion.";

  constructor(private readonly options: NotionToolOptions) {}

  matchesIntent(input: string): boolean {
    return /notion|ноушен|заметк.*notion|save.*notion|note.*notion|сделай.*заметк/i.test(input);
  }

  async execute(input: ToolExecutionRequest): Promise<ToolExecutionResult> {
    if (!this.options.apiKey || (!this.options.parentPageId && !this.options.dataSourceId)) {
      return {
        tool: this.name,
        ok: true,
        output: `Mock Notion note prepared: ${input.title}`,
        metadata: {
          configured: false
        }
      };
    }

    const response = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.options.apiKey}`,
        "Notion-Version": this.options.version
      },
      body: JSON.stringify(this.buildPayload(input))
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Notion request failed with status ${response.status}: ${errorText}`);
    }

    const payload = (await response.json()) as { id?: string; url?: string };

    return {
      tool: this.name,
      ok: true,
      output: payload.url
        ? `Created Notion note: ${payload.url}`
        : `Created Notion note with id ${payload.id ?? "unknown"}`,
      metadata: payload
    };
  }

  toDescriptor() {
    return {
      name: this.name,
      description: this.description
    };
  }

  private buildPayload(input: ToolExecutionRequest): Record<string, unknown> {
    const title = input.title.slice(0, 100);

    if (this.options.dataSourceId) {
      return {
        parent: {
          data_source_id: this.options.dataSourceId
        },
        properties: {
          [this.options.titleProperty]: {
            title: [
              {
                text: {
                  content: title
                }
              }
            ]
          }
        },
        markdown: input.content
      };
    }

    return {
      parent: {
        page_id: this.options.parentPageId
      },
      properties: {
        title: {
          title: [
            {
              text: {
                content: title
              }
            }
          ]
        }
      },
      markdown: input.content
    };
  }
}
