import path from "path";
import { canonicalPath, isWorkspacePath } from "../../tools/AccessPolicy";

export class WorkflowPathPolicy {
  constructor(
    private readonly accessMode: "restricted" | "full",
    private readonly allowedDirectories: string[],
    private readonly defaultDirectory: string
  ) {}

  async resolve(rawPath: string): Promise<string> {
    const target = await canonicalPath(path.resolve(
      path.isAbsolute(rawPath) ? rawPath : path.join(this.defaultDirectory, rawPath)
    ));
    await this.assertAllowed(target);
    return target;
  }

  async assertAllowed(targetPath: string): Promise<void> {
    if (this.accessMode === "full") {
      return;
    }

    const allowed = await isWorkspacePath(targetPath, this.allowedDirectories);

    if (!allowed) {
      throw new Error(`Workflow filesystem access blocked for path: ${targetPath}`);
    }
  }
}
