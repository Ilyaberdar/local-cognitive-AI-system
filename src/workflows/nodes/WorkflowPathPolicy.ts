import path from "path";

export class WorkflowPathPolicy {
  constructor(
    private readonly accessMode: "restricted" | "full",
    private readonly allowedDirectories: string[],
    private readonly defaultDirectory: string
  ) {}

  resolve(rawPath: string): string {
    const target = path.resolve(
      path.isAbsolute(rawPath) ? rawPath : path.join(this.defaultDirectory, rawPath)
    );
    this.assertAllowed(target);
    return target;
  }

  assertAllowed(targetPath: string): void {
    if (this.accessMode === "full") {
      return;
    }

    const allowed = this.allowedDirectories.some((directory) => {
      const root = path.resolve(directory);
      return targetPath === root || targetPath.startsWith(`${root}${path.sep}`);
    });

    if (!allowed) {
      throw new Error(`Workflow filesystem access blocked for path: ${targetPath}`);
    }
  }
}
