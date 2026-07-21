import fs from "fs/promises";
import path from "path";
import { NodeResult } from "../types";
import {
  readConfigNumber,
  readConfigString,
  readConfigStringArray,
  renderWorkflowTemplate
} from "../template";
import { NodeExecutionContext, NodeExecutor } from "./NodeExecutor";
import { WorkflowPathPolicy } from "./WorkflowPathPolicy";

interface FileSearchNodeExecutorOptions {
  accessMode: "restricted" | "full";
  allowedDirectories: string[];
  workspaceDir: string;
}

interface FileSearchMatch {
  path: string;
  line?: number;
  text?: string;
}

export class FileSearchNodeExecutor implements NodeExecutor {
  readonly type = "file_search" as const;
  private readonly paths: WorkflowPathPolicy;

  constructor(private readonly options: FileSearchNodeExecutorOptions) {
    this.paths = new WorkflowPathPolicy(
      options.accessMode,
      options.allowedDirectories,
      options.workspaceDir
    );
  }

  async execute(context: NodeExecutionContext): Promise<NodeResult> {
    const config = context.node.config;
    const root = this.paths.resolve(renderWorkflowTemplate(readConfigString(config, "root", "."), context));
    const query = renderWorkflowTemplate(readConfigString(config, "queryTemplate", ""), context).trim();
    const includes = readConfigStringArray(config, "include", ["**/*"]);
    const excludes = readConfigStringArray(config, "exclude", [
      "**/.git/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/release/**"
    ]);
    const maxFiles = readConfigNumber(config, "maxFiles", 500, 1, 5000);
    const maxResults = readConfigNumber(config, "maxResults", 40, 1, 200);
    const maxFileBytes = readConfigNumber(config, "maxFileBytes", 524288, 1024, 5_000_000);
    const files = await collectFiles(root, includes, excludes, maxFiles);
    const results: FileSearchMatch[] = [];

    for (const filePath of files) {
      if (results.length >= maxResults) break;
      const stat = await fs.stat(filePath);
      const relativePath = path.relative(root, filePath) || path.basename(filePath);

      if (!query) {
        results.push({ path: relativePath });
        continue;
      }

      if (stat.size > maxFileBytes) continue;
      const content = await fs.readFile(filePath, "utf8").catch(() => "");
      if (!content || content.includes("\u0000")) continue;

      content.split(/\r?\n/).forEach((line, index) => {
        if (results.length >= maxResults) return;
        if (line.toLocaleLowerCase().includes(query.toLocaleLowerCase())) {
          results.push({
            path: relativePath,
            line: index + 1,
            text: line.length > 500 ? `${line.slice(0, 497)}...` : line
          });
        }
      });
    }

    return {
      status: "ok",
      event: "file_search.completed",
      summary: `Found ${results.length} matches across ${files.length} files.`,
      data: {
        root,
        query,
        scannedFiles: files.length,
        results
      }
    };
  }
}

const collectFiles = async (
  root: string,
  includes: string[],
  excludes: string[],
  maxFiles: number
): Promise<string[]> => {
  const files: string[] = [];
  const queue = [root];
  const includeMatchers = includes.map(globToRegExp);
  const excludeMatchers = excludes.map(globToRegExp);

  while (queue.length && files.length < maxFiles) {
    const directory = queue.shift()!;
    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");

      if (excludeMatchers.some((matcher) => matcher.test(relative))) continue;
      if (entry.isDirectory()) queue.push(absolute);
      else if (entry.isFile() && includeMatchers.some((matcher) => matcher.test(relative))) files.push(absolute);
      if (files.length >= maxFiles) break;
    }
  }

  return files.sort();
};

const globToRegExp = (glob: string): RegExp => {
  let pattern = "^";

  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    const next = glob[index + 1];

    if (character === "*" && next === "*") {
      if (glob[index + 2] === "/") {
        pattern += "(?:.*/)?";
        index += 2;
      } else {
        pattern += ".*";
        index += 1;
      }
    } else if (character === "*") {
      pattern += "[^/]*";
    } else if (character === "?") {
      pattern += "[^/]";
    } else {
      pattern += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }

  return new RegExp(`${pattern}$`, "i");
};
